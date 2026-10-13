'use strict';

/* ---------- Constantes ---------- */
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-top-read',
  'user-read-recently-played',
].join(' ');
const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

/* ---------- Utilidades ---------- */
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeStore(storage) {
  return {
    get(k) { try { return storage.getItem(k); } catch { return null; } },
    set(k, v) { try { storage.setItem(k, v); } catch { /* sin almacenamiento */ } },
    del(k) { try { storage.removeItem(k); } catch { /* sin almacenamiento */ } },
  };
}
const store = makeStore(localStorage);      // solo tokens de sesión
const session = makeStore(sessionStorage);  // datos temporales del login

let config = null;
let player = null;
let deviceId = null;

// Todo lo que viene de Spotify vive solo en memoria mientras la pestaña está abierta.
const state = {
  range: 'short_term',
  loadId: 0,
  topTracks: [],
  topArtists: [],
  genres: [],
  recArtist: null,      // { id, name, tracks, similar, note, loading }
  recLoad: 0,           // para ignorar búsquedas de un artista ya superado
  recCache: new Map(),  // nombre de artista -> resultado ya cargado
  recentIds: new Set(),
  heard: new Set(),
  knownArtistIds: new Set(),
  lastTrackId: null,
  failedIds: new Set(),   // canciones que el reproductor no ha podido reproducir
  errorStreak: 0,         // fallos de reproducción seguidos
  lastUserAction: 0,      // para distinguir una pausa tuya de una pausa "sola"
  playerMsg: false,       // hay un aviso del reproductor en pantalla
  okTimer: null,
  lastfmOff: false,       // el servidor no tiene clave de Last.fm
  lastTick: null,         // última observación del reproductor (para detectar el final)
  endFired: false,        // ya se ha disparado el salto al relacionado para esta canción
  me: null,               // perfil de Spotify (nombre e imagen)
  counted: new Set(),     // canciones ya contadas en esta reproducción
  ticker: null,
  currentId: null,        // canción que está sonando ahora
  dragging: false,        // el usuario está moviendo la barra de progreso
  trackInfo: new Map(),   // id -> pista de Spotify (artistas con id, duración)
  artistGenres: new Map(),// id de artista -> géneros

  // Volumen y fundido
  volume: 0.7,            // volumen elegido por ti (0 a 1)
  fade: false,            // ¿fundido entre canciones?
  fadeMs: 6000,           // duración del fundido
  fadeTicker: null,
  lastGain: 1,            // último multiplicador aplicado por el fundido
  posBase: null,          // para estimar la posición entre consultas
};

/* ---------- Preferencias guardadas en el navegador ---------- */
function loadPrefs() {
  // Ojo: si la clave no existe, store.get devuelve null y Number(null) es 0,
  // así que hay que comprobar el texto antes de convertirlo.
  const num = (key) => {
    const raw = store.get(key);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const vol = num('volume');
  if (vol !== null && vol >= 0 && vol <= 1) state.volume = vol;
  const len = num('fade_ms');
  if (len !== null && len >= 2000 && len <= 12000) state.fadeMs = len;
  state.fade = store.get('fade') === '1';
}

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text || '';
  el.classList.toggle('err', Boolean(isError));
}

/* ---------- Formato y datos de canciones ---------- */
function fmtTime(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Contador local: cuenta una reproducción cuando la canción supera los 30 segundos
// (el mismo criterio que usa Spotify). Solo cuenta lo que pones desde SpoDJ.
function playCounts() {
  try { return JSON.parse(store.get('plays') || '{}') || {}; } catch { return {}; }
}
function playCount(id) {
  return playCounts()[id] || 0;
}
function bumpPlay(id, info = {}) {
  const counts = playCounts();
  counts[id] = (counts[id] || 0) + 1;
  store.set('plays', JSON.stringify(counts));

  // Estadísticas detalladas: nombre, artista, duración y reproducciones por día.
  const all = statsData();
  const s = all[id] || { n: 0, name: '', artist: '', ms: 0, days: {} };
  s.n += 1;
  s.name = info.name || s.name;
  s.artist = info.artist || s.artist;
  s.ms = info.ms || s.ms;
  const k = dayKey(new Date());
  s.days[k] = (s.days[k] || 0) + 1;
  all[id] = s;
  store.set('stats', JSON.stringify(all));
}

function statsData() {
  try { return JSON.parse(store.get('stats') || '{}') || {}; } catch { return {}; }
}
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rememberTrack(track) {
  if (track?.id) state.trackInfo.set(track.id, track);
}

// El género viene del artista, no de la canción. Mientras se piden, muestra "cargando…".
function genreText(track) {
  const artists = (track?.artists || []).filter((a) => a.id);
  if (artists.some((a) => !state.artistGenres.has(a.id))) return 'cargando…';
  const genres = [];
  for (const a of artists) {
    for (const g of state.artistGenres.get(a.id) || []) {
      if (!genres.includes(g)) genres.push(g);
    }
  }
  return genres.length ? genres.slice(0, 2).join(' · ') : 'sin datos';
}

/* PURE-START */
// Puntúa los géneros de los artistas más escuchados: los primeros del ranking pesan más.
function computeGenres(artists, max = 6) {
  const scores = new Map();
  artists.forEach((artist, i) => {
    const weight = artists.length - i;
    for (const genre of artist.genres || []) {
      scores.set(genre, (scores.get(genre) || 0) + weight);
    }
  });
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([genre, score]) => ({ genre, score }));
}

// Elige recomendaciones: sin repetidas, sin excluidas, primero artistas nuevos
// y como mucho "maxPerArtist" canciones por artista.
function pickRecommendations(candidates, excludedIds, knownArtistIds, max = 8, maxPerArtist = 2) {
  const seen = new Set();
  const unique = [];
  for (const t of candidates) {
    if (!t || !t.id || seen.has(t.id) || excludedIds.has(t.id)) continue;
    seen.add(t.id);
    unique.push(t);
  }
  const isKnown = (t) => (t.artists || []).some((a) => knownArtistIds.has(a.id));
  const ordered = [...unique.filter((t) => !isKnown(t)), ...unique.filter(isKnown)];
  const perArtist = new Map();
  const picked = [];
  for (const t of ordered) {
    const artistId = t.artists?.[0]?.id || t.id;
    const n = perArtist.get(artistId) || 0;
    if (n >= maxPerArtist) continue;
    perArtist.set(artistId, n + 1);
    picked.push(t);
    if (picked.length >= max) break;
  }
  return picked;
}

// Curva del fundido: devuelve el multiplicador de volumen (0 a 1) según la
// posición dentro de la canción. Sube al empezar y baja al terminar.
// En canciones cortas el fundido se recorta para que no ocupe toda la pista.
function fadeGain(position, duration, fadeMs) {
  if (!duration || !fadeMs || fadeMs <= 0) return 1;
  const len = Math.min(fadeMs, Math.floor(duration / 3));
  if (len <= 0) return 1;
  const pos = Math.max(0, Math.min(position, duration));
  const remaining = duration - pos;
  const gain = Math.min(pos / len, remaining / len, 1);
  return Math.max(0, Math.min(1, gain));
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
/* PURE-END */

/* ---------- Login con Spotify (PKCE) ---------- */
function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function login() {
  const verifier = randomString(64);
  const challenge = base64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  );
  const state_ = randomString(16);
  session.set('pkce_verifier', verifier);
  session.set('pkce_state', state_);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    scope: SCOPES,
    redirect_uri: config.redirectUri,
    state: state_,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  location.href = `${AUTH_URL}?${params}`;
}

async function requestToken(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Spotify rechazó el token (${res.status}).`);
  const data = await res.json();
  store.set('access_token', data.access_token);
  store.set('expires_at', String(Date.now() + data.expires_in * 1000));
  if (data.refresh_token) store.set('refresh_token', data.refresh_token);
}

// Devuelve true si estábamos en /callback y el login se completó.
async function handleCallback() {
  if (location.pathname !== '/callback') return false;
  const params = new URLSearchParams(location.search);
  const error = params.get('error');
  if (error) throw new Error(`Spotify no ha dado acceso (${error}).`);

  const code = params.get('code');
  if (!code || params.get('state') !== session.get('pkce_state')) {
    throw new Error('Respuesta de Spotify no válida. Vuelve a intentarlo.');
  }
  await requestToken(
    new URLSearchParams({
      client_id: config.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      code_verifier: session.get('pkce_verifier') || '',
    })
  );
  store.set('scopes', SCOPES); // para detectar si más adelante cambian los permisos
  session.del('pkce_verifier');
  session.del('pkce_state');
  window.history.replaceState({}, '', '/');
  return true;
}

let refreshing = null;
async function getToken() {
  const access = store.get('access_token');
  const expiresAt = Number(store.get('expires_at') || 0);
  if (access && Date.now() < expiresAt - 60_000) return access;

  const refresh = store.get('refresh_token');
  if (!refresh) throw new Error('Sesión caducada');
  if (!refreshing) {
    refreshing = requestToken(
      new URLSearchParams({
        client_id: config.clientId,
        grant_type: 'refresh_token',
        refresh_token: refresh,
      })
    ).finally(() => { refreshing = null; });
  }
  await refreshing;
  return store.get('access_token');
}

async function api(path, options = {}) {
  const token = await getToken();
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

// GET con reintento si Spotify limita las peticiones y mensajes de error claros.
async function apiJson(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await api(path);
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Number(res.headers.get('Retry-After')) || 2, 10);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 401) {
      logout('Tu sesión ha caducado. Conéctate de nuevo.');
      throw new Error('Sesión caducada');
    }
    if (res.status === 403) {
      throw new Error('Spotify ha denegado el acceso (403). Revisa que tu cuenta esté en "User management" de tu app del Dashboard.');
    }
    if (!res.ok) {
      const err = new Error(`Spotify respondió con un error (${res.status}).`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
  const err = new Error('Spotify está limitando las peticiones. Espera un minuto y pulsa Actualizar.');
  err.status = 429;
  throw err;
}

function logout(message) {
  ['access_token', 'expires_at', 'refresh_token', 'scopes'].forEach((k) => store.del(k));
  clearInterval(state.ticker);
  clearInterval(state.fadeTicker);
  state.ticker = null;
  state.fadeTicker = null;
  try { player?.disconnect(); } catch { /* ya desconectado */ }
  player = null;
  deviceId = null;
  state.me = null;
  renderProfile();
  showLogin(message);
}

/* ---------- Reproductor (Web Playback SDK) ---------- */
function initPlayer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('El reproductor de Spotify no ha respondido. Prueba con Chrome, Edge o Firefox.')),
      20_000
    );

    window.onSpotifyWebPlaybackSDKReady = () => {
      player = new Spotify.Player({
        name: 'SpoDJ',
        getOAuthToken: (cb) => { getToken().then(cb).catch(() => logout('Tu sesión ha caducado.')); },
        volume: state.volume,
      });

      player.addListener('ready', ({ device_id }) => {
        deviceId = device_id;
        clearTimeout(timer);
        // Refresca la barra de progreso y el botón play/pausa cada medio segundo.
        if (!state.ticker) state.ticker = setInterval(tick, 500);
        resolve();
      });
      player.addListener('not_ready', () => setStatus('El reproductor se ha desconectado.', true));
      player.addListener('initialization_error', ({ message }) => setStatus(`Error del reproductor: ${message}`, true));
      player.addListener('authentication_error', () => logout('Spotify no ha validado tu sesión. Conéctate de nuevo.'));
      player.addListener('account_error', () => setStatus('Spotify indica que esta cuenta no puede reproducir aquí: hace falta Premium.', true));
      player.addListener('autoplay_failed', () => playerNote('El navegador ha bloqueado la reproducción automática. Pulsa ⏯ para continuar.'));
      player.addListener('playback_error', ({ message }) => handlePlaybackError(message));
      player.addListener('player_state_changed', (st) => {
        if (!st) return;
        applyState(st);
        const t = st.track_window.current_track;

        // Registro para diagnosticar (se ve en la consola del navegador, F12).
        console.log('[SpoDJ] estado', JSON.stringify({
          pista: t.name, id: t.id, pausado: st.paused, cargando: st.loading,
          posicion_s: Math.round(st.position / 1000), duracion_s: Math.round(st.duration / 1000),
          restricciones: st.restrictions,
        }));

        // Pausa que no has pedido tú, muy al principio de la canción.
        const unasked = Date.now() - state.lastUserAction > 3000;
        if (st.paused && !st.loading && st.position > 0 && st.position < 15000 && unasked) {
          playerNote(`La reproducción se ha parado a los ${Math.round(st.position / 1000)} s sin que lo pidieras. ` +
            'Suele pasar si Spotify se abre o se reproduce en otro dispositivo de tu cuenta, o si falla la conexión.');
        }
      });
      player.connect();
    };

    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.onerror = () => reject(new Error('No se ha podido cargar el reproductor de Spotify.'));
    document.body.appendChild(script);
  });
}

// Debe llamarse directamente desde un clic (el navegador exige un gesto para reproducir audio).
async function playUris(uris) {
  if (!deviceId) {
    setStatus('El reproductor aún se está conectando. Espera unos segundos.', true);
    return;
  }
  try { player?.activateElement(); } catch { /* no crítico */ }
  state.lastUserAction = Date.now();
  state.errorStreak = 0;
  state.playerMsg = false;
  setStatus('');
  if (!state.fade) applyOutputVolume(1); // sin fundido, volumen entero desde el principio
  // Quitamos las que ya sabemos que no suenan en este navegador/país.
  uris = uris.filter((u) => !state.failedIds.has(u.split(':').pop()));
  if (!uris.length) {
    setStatus('Ninguna de esas canciones se puede reproducir aquí.', true);
    return;
  }
  const res = await api(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
    method: 'PUT',
    body: JSON.stringify({ uris }),
  });
  if (!res.ok && res.status !== 204) {
    setStatus(`Spotify no ha podido empezar la reproducción (${res.status}).`, true);
  }
}

/* ---------- Errores de reproducción ---------- */
function playerNote(text) {
  state.playerMsg = true;
  setStatus(text, true);
}

// Si una canción no se puede reproducir: la marcamos, la quitamos de las
// recomendaciones y saltamos a la siguiente. Si fallan tres seguidas, paramos
// y avisamos, porque entonces el problema no son las canciones sino el navegador.
async function handlePlaybackError(message) {
  let st = null;
  try { st = await player.getCurrentState(); } catch { /* sin estado */ }
  const t = st?.track_window?.current_track;
  console.warn('[SpoDJ] playback_error:', message, '| pista:', t?.name, t?.id, '| estado:', st);

  if (t?.id) {
    state.failedIds.add(t.id);
    if (state.recArtist) state.recArtist.tracks = state.recArtist.tracks.filter((x) => x.id !== t.id);
    renderTop();
    renderRecs();
  }

  state.errorStreak += 1;
  if (state.errorStreak >= 3) {
    try { await player.pause(); } catch { /* ya parado */ }
    playerNote('Fallan varias canciones seguidas, así que probablemente no son las canciones sino el navegador ' +
      '(la protección DRM/Widevine). Abre SpoDJ en Chrome, Edge o Firefox, no en el navegador integrado de VS Code.');
    return;
  }
  playerNote(`No se ha podido reproducir "${t?.name ?? 'esta canción'}". Paso a la siguiente…`);
  try { await player.nextTrack(); } catch { /* fin de la cola */ }
}

/* ---------- Pintar listas ---------- */
function smallCover(track) {
  const images = track.album?.images || [];
  return images.length ? images[images.length - 1].url : '';
}

function trackRow(track, rank, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'track-row';
  btn.dataset.id = track.id;
  rememberTrack(track);
  if (track.id === state.currentId) btn.classList.add('playing');
  if (state.failedIds.has(track.id)) {
    btn.classList.add('unplayable');
    btn.title = 'Esta canción no se ha podido reproducir en tu navegador o país';
  }

  if (rank) {
    const r = document.createElement('span');
    r.className = 'rank';
    r.textContent = String(rank);
    btn.appendChild(r);
  }
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.src = smallCover(track);
  btn.appendChild(img);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const tt = document.createElement('div');
  tt.className = 'tt';
  tt.textContent = track.name;
  const ta = document.createElement('div');
  ta.className = 'ta';
  ta.textContent = (track.artists || []).map((a) => a.name).join(', ');
  const tg = document.createElement('div');
  tg.className = 'tg';
  tg.textContent = genreText(track);
  meta.append(tt, ta, tg);
  btn.appendChild(meta);

  const dur = document.createElement('span');
  dur.className = 'dur';
  dur.textContent = fmtTime(track.duration_ms);
  btn.appendChild(dur);

  const n = playCount(track.id);
  if (n > 0) {
    const pc = document.createElement('span');
    pc.className = 'pc';
    pc.textContent = `${n}×`;
    pc.title = 'Veces que la has escuchado en SpoDJ';
    btn.appendChild(pc);
  }

  btn.addEventListener('click', onClick);
  return btn;
}

function emptyNote(text) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  return div;
}

function renderTop() {
  const list = $('top-list');
  list.textContent = '';
  if (!state.topTracks.length) {
    list.appendChild(emptyNote('Todavía no hay suficiente historial en este periodo. Prueba con otro.'));
    return;
  }
  state.topTracks.forEach((track, i) => {
    list.appendChild(
      trackRow(track, i + 1, () => playUris(state.topTracks.slice(i).map((t) => t.uri)))
    );
  });
}

function renderGenres() {
  const box = $('genres');
  box.textContent = '';
  if (!state.genres.length) {
    box.appendChild(emptyNote(state.lastfmOff
      ? 'Spotify no devuelve géneros para estos artistas. Añade LASTFM_API_KEY en el .env para verlos.'
      : 'Spotify no ha devuelto géneros para tus artistas en este periodo.'));
    return;
  }
  state.genres.forEach(({ genre }, i) => {
    // Número: cuántos artistas de tu top tienen ese género
    const count = state.topArtists.filter((a) => (a.genres || []).includes(genre)).length;
    const chip = document.createElement('span');
    chip.className = i < 3 ? 'chip on' : 'chip';
    chip.textContent = `${genre} · ${count}`;
    chip.title = `${count} de tus artistas más escuchados`;
    box.appendChild(chip);
  });
}

/* ---------- Géneros de respaldo (Last.fm) ---------- */
// Etiquetas de un artista: primero la caché del navegador (dura entre sesiones), luego Last.fm.
const GENRE_CACHE_KEY = 'genre_cache';
const GENRE_CACHE_DAYS = 30;
function readGenreCache() {
  try { return JSON.parse(store.get(GENRE_CACHE_KEY) || '{}') || {}; } catch { return {}; }
}
function writeGenreCache(cache) {
  store.set(GENRE_CACHE_KEY, JSON.stringify(cache));
}
async function lastfmTags(name) {
  const cache = readGenreCache();
  const hit = cache[name.toLowerCase()];
  if (hit && Date.now() - hit.at < GENRE_CACHE_DAYS * 864e5) return hit.tags;
  const res = await fetch(`/api/tags?${new URLSearchParams({ artist: name })}`);
  const data = await res.json();
  if (data.configured === false) state.lastfmOff = true;
  if (data.error) return null; // no guardamos errores: se reintentará
  const tags = data.tags || [];
  cache[name.toLowerCase()] = { tags, at: Date.now() };
  writeGenreCache(cache);
  return tags;
}

// Si Spotify no devuelve géneros para un artista, usamos las etiquetas de Last.fm.
async function fillMissingGenres() {
  const missing = state.topArtists.filter((a) => !(a.genres && a.genres.length));
  for (let i = 0; i < missing.length; i += 4) {
    await Promise.all(missing.slice(i, i + 4).map(async (artist) => {
      try {
        const tags = await lastfmTags(artist.name);
        if (tags?.length) {
          artist.genres = tags;
          state.artistGenres.set(artist.id, tags);
        }
      } catch {
        /* sin etiquetas para este artista */
      }
    }));
  }
}

/* ---------- Carga de datos ---------- */
// Recomendaciones por género: búsqueda con el filtro genre: y una página al azar,
// para que no salgan siempre las mismas.
async function loadAll() {
  const myLoad = ++state.loadId;
  setStatus('Cargando tu música…');
  $('top-list').textContent = '';
  $('genres').textContent = '';
  state.recArtist = null;
  renderRecs();

  try {
    const q = (n) => new URLSearchParams({ time_range: state.range, limit: String(n) });
    const [tracksRes, artistsRes, recentRes] = await Promise.all([
      apiJson(`/me/top/tracks?${q(20)}`),
      apiJson(`/me/top/artists?${q(30)}`),
      apiJson('/me/player/recently-played?limit=50').catch(() => ({ items: [] })),
    ]);
    if (myLoad !== state.loadId) return;

    state.topTracks = (tracksRes.items || []).filter(Boolean);
    state.topArtists = (artistsRes.items || []).filter(Boolean);
    state.recentIds = new Set((recentRes.items || []).map((i) => i.track?.id).filter(Boolean));
    state.knownArtistIds = new Set(state.topArtists.map((a) => a.id));
    await fillMissingGenres();
    if (myLoad !== state.loadId) return;
    state.genres = computeGenres(state.topArtists);
    state.topArtists.forEach((a) => state.artistGenres.set(a.id, a.genres || []));
    renderTop();
    renderGenres();

    if (myLoad === state.loadId) setStatus('');
    refreshGenres();
    if (!state.currentId && state.topArtists[0]) {
      loadArtistRecs(state.topArtists[0].name, state.topArtists[0].id);
    }
  } catch (err) {
    if (myLoad === state.loadId) setStatus(err.message, true);
  }
}

/* ---------- Las recomendaciones cambian según lo que escuchas ---------- */
function onTrackChange(id) {
  if (!id || id === state.lastTrackId) return;
  state.lastTrackId = id;
  state.heard.add(id);

  // Si tras 6 segundos sigue sonando esta canción, la reproducción va bien: se reinician los fallos.
  clearTimeout(state.okTimer);
  state.okTimer = setTimeout(async () => {
    let st = null;
    try { st = await player?.getCurrentState(); } catch { /* sin estado */ }
    if (st && !st.paused && st.track_window.current_track.id === id && st.position > 4000) {
      state.errorStreak = 0;
      if (state.playerMsg) { state.playerMsg = false; setStatus(''); }
    }
  }, 6000);

}

/* ---------- Ficha de la canción sonando ---------- */
const pendingArtists = new Set();

// Pinta el estado del reproductor: botón play/pausa, canción, progreso y resaltado.
function applyState(st) {
  if (!st) return;
  const t = st.track_window.current_track;
  const paused = Boolean(st.paused);

  $('toggle-btn').textContent = paused ? '▶' : '⏸';
  $('toggle-btn').title = paused ? 'Reproducir' : 'Pausa';
  $('now').classList.toggle('playing', !paused);

  if (t.id && t.id !== state.currentId) {
    state.currentId = t.id;
    state.endFired = false;
    state.counted.clear();
    $('track-title').textContent = t.name;
    $('track-artist').textContent = t.artists.map((a) => a.name).join(', ');
    $('cover').src = t.album.images?.[0]?.url || '';
    applyNowColor(t.album.images?.[0]?.url || '');
    setBgArt(t.album.images?.[0]?.url || '');
    markPlaying();
    updateNowGenre();
    onTrackChange(t.id);
    refreshGenres();
    const artist = state.trackInfo.get(t.id)?.artists?.[0] || { id: null, name: t.artists[0]?.name };
    if (artist.name) loadArtistRecs(artist.name, artist.id);

  }

  updateMediaSession(t, paused, st.position || 0, st.duration || 0);

  // Guardamos la última posición conocida para poder estimarla entre consultas.
  state.posBase = { position: st.position || 0, duration: st.duration || 0, paused, at: Date.now() };

  // Fin de la última recomendación del artista. Al acabar, Spotify para (y a veces repite
  // la misma canción en pausa) en vez de cambiar de id, así que miramos la posición anterior.
  const before = state.lastTick;
  state.lastTick = { id: t.id, position: st.position || 0, duration: st.duration || 0, paused };
  const lastRec = state.recArtist?.tracks?.at(-1);
  if (lastRec && before && before.id === lastRec.id && before.duration
      && before.position >= before.duration - 2500 && !state.endFired
      && (paused || t.id !== before.id)) {
    state.endFired = true;
    continueWithRelated(state.recArtist.similar?.[0]);
  }

  // Contador de reproducciones: al superar 30 s de una canción, una vez por reproducción.
  if (!paused && t.id && st.position >= 30000 && !state.counted.has(t.id)) {
    state.counted.add(t.id);
    bumpPlay(t.id, { name: t.name, artist: t.artists?.[0]?.name || '', ms: st.duration || 0 });
    const info = state.trackInfo.get(t.id) || {
      id: t.id,
      uri: `spotify:track:${t.id}`,
      name: t.name,
      duration_ms: st.duration,
      artists: t.artists.map((a) => ({ id: a.uri ? a.uri.split(':').pop() : null, name: a.name })),
      album: t.album,
    };
    pushHistory(info);
    renderHistory();
    renderAllTracks();
  }

  $('t-dur').textContent = fmtTime(st.duration);
  if (!state.dragging) {
    $('seek').max = String(st.duration || 1);
    $('seek').value = String(st.position || 0);
    $('t-cur').textContent = fmtTime(st.position);
  }
}

async function tick() {
  if (!player) return;
  try { applyState(await player.getCurrentState()); } catch { /* sin estado */ }
}

/* ---------- Historial de SpoDJ ---------- */
// Guarda las últimas 20 canciones que has escuchado aquí (en el navegador).
const HISTORY_MAX = 20;

function historyItems() {
  try {
    const list = JSON.parse(store.get('history') || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function pushHistory(track) {
  const entry = {
    id: track.id,
    uri: track.uri,
    name: track.name,
    duration_ms: track.duration_ms,
    artists: (track.artists || []).map((a) => ({ id: a.id || null, name: a.name })),
    album: { images: track.album?.images || [] },
    at: Date.now(),
  };
  const list = historyItems().filter((x) => x.id !== entry.id);
  list.unshift(entry);
  store.set('history', JSON.stringify(list.slice(0, HISTORY_MAX)));
}

function renderHistory() {
  const box = $('history-list');
  box.textContent = '';
  const items = historyItems();
  if (!items.length) {
    box.appendChild(emptyNote('Aquí aparecerán las últimas canciones que escuches en SpoDJ.'));
    return;
  }
  items.forEach((track, i) => {
    box.appendChild(trackRow(track, 0, () => playUris(items.slice(i).map((t) => t.uri))));
  });
}

/* ---------- Volumen y fundido ---------- */
// El volumen real que se manda a Spotify es el tuyo multiplicado por el
// atenuador del fundido (1 = sin atenuar).
function applyOutputVolume(gain = state.lastGain) {
  state.lastGain = gain;
  const level = Math.max(0, Math.min(1, state.volume * gain));
  try {
    player?.setVolume(level)?.catch(() => { /* el reproductor aún no está listo */ });
  } catch { /* nunca debe cortar la reproducción por no poder ajustar el volumen */ }
}

function renderVolume() {
  const pct = Math.round(state.volume * 100);
  $('volume').value = String(pct);
  $('vol-pct').textContent = `${pct} %`;
  $('vol-icon').textContent = pct === 0 ? '🔇' : pct < 34 ? '🔈' : pct < 67 ? '🔉' : '🔊';
}

function renderFadeControls() {
  $('fade-chk').checked = state.fade;
  $('fade-opts').hidden = !state.fade;
  $('fade-len').value = String(Math.round(state.fadeMs / 1000));
  $('fade-secs').textContent = `${Math.round(state.fadeMs / 1000)} s`;
}

// Posición estimada sin preguntar al reproductor, para que el fundido sea suave.
function estimatedPosition() {
  const base = state.posBase;
  if (!base) return null;
  const pos = base.paused ? base.position : base.position + (Date.now() - base.at);
  return { position: Math.min(pos, base.duration), duration: base.duration, paused: base.paused };
}

function fadeTick() {
  const p = estimatedPosition();
  if (!p || !p.duration || p.paused) return;
  updateBgFadeOut(p);
  const gain = fadeGain(p.position, p.duration, state.fadeMs);
  // Solo mandamos el cambio si se nota, para no saturar al reproductor.
  if (Math.abs(gain - state.lastGain) > 0.02) applyOutputVolume(gain);
}

// Portada de fondo: aparece en 2 s al empezar la canción y, si el fundido está activo,
// se desvanece junto con el final de la canción.
const BG_OPACITY = 0.2;
const BG_FADE_IN_MS = 2000;
function setBgArt(url) {
  const img = $('bg-art');
  if (!url) {
    img.removeAttribute('src');
    img.style.opacity = '0';
    return;
  }
  if (img.dataset.src !== url) {
    img.dataset.src = url;
    img.src = url;
  }
  // Empieza invisible y, tras un reflow, sube a su opacidad en 2 s
  img.style.transition = 'none';
  img.style.opacity = '0';
  void img.offsetWidth;
  img.style.transition = `opacity ${BG_FADE_IN_MS}ms ease`;
  img.style.opacity = String(BG_OPACITY);
}
function updateBgFadeOut(p) {
  const img = $('bg-art');
  if (!img.dataset.src) return;
  const len = Math.min(state.fadeMs, Math.floor(p.duration / 3));
  if (len <= 0) return;
  const out = Math.max(0, Math.min(1, (p.duration - p.position) / len));
  // Solo actuamos cuando la canción se está acabando; si no, dejamos la entrada en marcha
  if (out >= 1) return;
  img.style.transition = 'opacity .15s linear';
  img.style.opacity = String(BG_OPACITY * out);
}
function restoreBgArt() {
  const img = $('bg-art');
  if (!img.dataset.src) return;
  img.style.transition = 'opacity .35s ease';
  img.style.opacity = String(BG_OPACITY);
}

function startFade() {
  if (state.fadeTicker) return;
  state.fadeTicker = setInterval(fadeTick, 150);
}

function stopFade() {
  clearInterval(state.fadeTicker);
  state.fadeTicker = null;
  applyOutputVolume(1); // devolvemos el volumen entero
  restoreBgArt();
}

function setFade(on) {
  state.fade = Boolean(on);
  store.set('fade', state.fade ? '1' : '0');
  renderFadeControls();
  if (state.fade) startFade(); else stopFade();
}

// Color de la portada: solo tiñe la ficha del reproductor, no el resto de la web.
const coverColors = new Map();
function extractCoverColor(url) {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || !url) return resolve(null);
    if (coverColors.has(url)) return resolve(coverColors.get(url));
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 24;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 24, 24);
        const data = ctx.getImageData(0, 0, 24, 24).data;
        // Media de los píxeles con color (no grises ni casi negros o blancos)
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const max = Math.max(data[i], data[i + 1], data[i + 2]);
          const min = Math.min(data[i], data[i + 1], data[i + 2]);
          const sat = max === 0 ? 0 : (max - min) / max;
          const light = max / 255;
          if (sat > 0.25 && light > 0.2 && light < 0.9) {
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
          }
        }
        if (!n) return resolve(null);
        const color = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
        coverColors.set(url, color);
        resolve(color);
      } catch {
        resolve(null); // imagen bloqueada por el navegador: se mantiene el color normal
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
async function applyNowColor(url) {
  const now = $('now');
  const color = await extractCoverColor(url);
  if (!color) {
    now.style.removeProperty('--np');
    now.style.removeProperty('--np-ink');
    return;
  }
  // Luminosidad percibida para elegir texto oscuro o claro encima del color
  const [r, g, b] = color;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  now.style.setProperty('--np', `rgb(${r}, ${g}, ${b})`);
  now.style.setProperty('--np-ink', lum > 0.55 ? '#0b0c10' : '#ffffff');
}

function updateNowGenre() {
  const t = state.trackInfo.get(state.currentId);
  $('track-genre').textContent = t ? `Género: ${genreText(t)}` : '';
}

function markPlaying() {
  document.querySelectorAll('.track-row').forEach((row) => {
    row.classList.toggle('playing', row.dataset.id === state.currentId);
  });
}

function renderAllTracks() {
  renderTop();
  renderRecs();
  updateNowGenre();
}

// Los géneros son de los artistas. Pedimos los que faltan, en grupos pequeños,
// y repintamos a medida que llegan. Si falla, el género queda como "sin datos".
async function refreshGenres() {
  // Spotify ya no da géneros fiables por artista y su endpoint limita muy pronto (429),
  // así que los artistas sin género se resuelven con Last.fm (con caché) en vez de Spotify.
  const wanted = new Map();
  const collect = (t) => (t?.artists || []).forEach((a) => a.id && wanted.set(a.id, a.name));
  state.topTracks.forEach(collect);
  if (state.recArtist) state.recArtist.tracks.forEach(collect);
  collect(state.trackInfo.get(state.currentId));

  const missing = [...wanted]
    .filter(([id]) => !state.artistGenres.has(id) && !pendingArtists.has(id))
    .slice(0, 40);
  for (const [id, name] of missing) {
    pendingArtists.add(id);
    try {
      const tags = await lastfmTags(name);
      if (tags !== null) state.artistGenres.set(id, tags);
    } catch {
      /* se reintentará en la próxima actualización */
    } finally {
      pendingArtists.delete(id);
    }
    renderAllTracks();
    await sleep(150);
  }
}

/* ---------- Color de énfasis ---------- */
// El primero es el color actual de la app y es el que se usa por defecto.
const ACCENTS = [
  { name: 'Verde (por defecto)', color: '#1ed760', ink: '#07210f' },
  { name: 'Rosa pastel', color: '#f4a7c0', ink: '#3a0f22' },
  { name: 'Lila pastel', color: '#b9a6f0', ink: '#1e1436' },
  { name: 'Azul pastel', color: '#98c8f2', ink: '#0c2540' },
  { name: 'Melocotón pastel', color: '#ffc59c', ink: '#3d1d05' },
];

function applyAccent(accent) {
  const root = document.documentElement.style;
  root.setProperty('--accent', accent.color);
  root.setProperty('--accent-ink', accent.ink);
  document.querySelectorAll('.swatch').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.color === accent.color));
  });
}

function renderAccentPicker() {
  const row = $('accent-row');
  const saved = store.get('accent');
  const current = ACCENTS.find((a) => a.color === saved) || ACCENTS[0];
  // Quitamos los botones anteriores (si los hay) y ponemos los nuevos
  row.querySelectorAll('.swatch').forEach((b) => b.remove());
  for (const accent of ACCENTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.dataset.color = accent.color;
    btn.style.setProperty('--c', accent.color);
    btn.title = accent.name;
    btn.setAttribute('aria-label', accent.name);
    btn.addEventListener('click', () => {
      store.set('accent', accent.color);
      applyAccent(accent);
    });
    row.appendChild(btn);
  }
  applyAccent(current);
}

/* ---------- Perfil ---------- */
async function loadProfile() {
  try {
    const me = await apiJson('/me');
    state.me = { name: me.display_name || 'Usuario de Spotify', image: me.images?.[0]?.url || '' };
  } catch {
    state.me = null;
  }
  renderProfile();
}

function renderProfile() {
  const logged = Boolean(store.get('refresh_token'));
  $('profile-name').textContent = logged ? (state.me?.name || 'Cargando perfil…') : 'Sin sesión';
  const img = $('profile-img');
  img.src = logged && state.me?.image ? state.me.image : '';
  img.hidden = !(logged && state.me?.image);
  $('profile-login').hidden = logged;
  $('profile-logout').hidden = !logged;
}

function toggleProfileMenu(force) {
  const menu = $('profile-menu');
  const open = typeof force === 'boolean' ? force : menu.hidden;
  menu.hidden = !open;
  $('profile-btn').setAttribute('aria-expanded', String(open));
}

/* ---------- Recomendaciones por artista ---------- */
// Canciones del artista: su top según Last.fm, buscado después en Spotify
// (Spotify ya no ofrece el top de un artista). Artistas relacionados: también Last.fm.
async function artistInfo(name, kind) {
  const res = await fetch(`/api/artist-info?${new URLSearchParams({ artist: name, kind })}`);
  if (!(res.headers.get('content-type') || '').includes('application/json')) {
    return { items: [], stale: true };
  }
  return res.json();
}

async function findSpotifyTrack(title, artistName) {
  const q = `track:"${title}" artist:"${artistName}"`;
  const data = await apiJson(`/search?${new URLSearchParams({ q, type: 'track', limit: '5', market: 'from_token' })}`);
  const items = (data.tracks?.items || []).filter((t) => t && t.is_playable !== false);
  const wanted = artistName.toLowerCase();
  return items.find((t) => (t.artists || []).some((a) => a.name.toLowerCase() === wanted)) || null;
}

// Tema aleatorio entre TODAS las canciones del artista en Spotify (no solo las cargadas).
// Spotify limita la búsqueda a 1000 resultados, así que elegimos una posición al azar en ese rango.
async function randomArtistTrack(name, button) {
  button.disabled = true;
  const wanted = name.toLowerCase();
  try {
    const q = `artist:"${name}"`;
    const first = await apiJson(`/search?${new URLSearchParams({ q, type: 'track', limit: '1', market: 'from_token' })}`);
    const total = Math.min(first.tracks?.total || 0, 1000);
    if (!total) {
      setStatus(`No encuentro canciones de ${name} en Spotify.`, true);
      return;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const offset = Math.floor(Math.random() * total);
      const data = await apiJson(`/search?${new URLSearchParams({ q, type: 'track', limit: '1', offset: String(offset), market: 'from_token' })}`);
      const t = (data.tracks?.items || [])[0];
      if (t && t.is_playable !== false && (t.artists || []).some((a) => a.name.toLowerCase() === wanted)) {
        setStatus(`Tema aleatorio de ${name}: ${t.name}`);
        playUris([t.uri]);
        return;
      }
    }
    setStatus(`No he conseguido un tema aleatorio de ${name}. Prueba otra vez.`, true);
  } catch (err) {
    setStatus(err.message || 'No se ha podido buscar el tema aleatorio.', true);
  } finally {
    button.disabled = false;
  }
}

async function loadArtistRecs(name, id = null) {
  if (!name) return;
  const loadId = ++state.recLoad;

  const cached = state.recCache.get(name);
  if (cached) {
    state.recArtist = { id, name, ...cached, loading: false };
    renderRecs();
    refreshGenres();
    return;
  }

  state.recArtist = { id, name, tracks: [], similar: [], note: '', loading: true };
  renderRecs();
  try {
    const [top, similar] = await Promise.all([artistInfo(name, 'tracks'), artistInfo(name, 'similar')]);
    if (loadId !== state.recLoad) return;

    const tracks = [];
    for (const item of (top.items || []).slice(0, 14)) {
      const found = await findSpotifyTrack(item.name, item.artist || name).catch(() => null);
      if (loadId !== state.recLoad) return;
      if (found && !tracks.some((t) => t.id === found.id)) {
        rememberTrack(found);
        tracks.push(found);
      }
      if (tracks.length >= 10) break;
    }

    let note = '';
    if (top.stale) note = 'El servidor necesita la versión nueva de server.js. Reinícialo.';
    else if (top.configured === false) note = 'Añade LASTFM_API_KEY en el .env para ver recomendaciones.';
    else if (top.error) note = `Last.fm: ${top.message || 'no se ha podido consultar'}.`;
    else if (!tracks.length) note = 'No he encontrado canciones de este artista en Spotify.';

    const result = { tracks, similar: (similar.items || []).map((i) => i.name).slice(0, 6), note };
    state.recCache.set(name, result);
    state.recArtist = { id, name, ...result, loading: false };
  } catch (err) {
    if (loadId !== state.recLoad) return;
    state.recArtist = { id, name, tracks: [], similar: [], note: err.message, loading: false };
  }
  renderRecs();
  refreshGenres();
}

// Carga el primer artista relacionado y empieza a sonar su lista de recomendaciones.
async function continueWithRelated(name) {
  if (!name) return;
  await loadArtistRecs(name);
  const r = state.recArtist;
  if (r && r.name === name && r.tracks.length) {
    playUris(r.tracks.map((t) => t.uri));
  } else {
    setStatus(`No he encontrado canciones de ${name} para seguir.`, true);
  }
}

// Descubrimiento a ciegas: elige un artista nuevo al azar entre los relacionados
// y reproduce sus canciones. Evita tus artistas del top y los que ya salieron.
const blindSeen = new Set();
async function discoverBlind(button) {
  // Excluimos lo que ya se ve en pantalla: tus artistas, los relacionados mostrados y los ya descubiertos.
  const shown = new Set((state.recArtist?.similar || []).map((n) => n.toLowerCase()));
  const excluded = new Set([
    ...(state.topArtists || []).map((x) => x.name.toLowerCase()),
    ...shown,
    ...blindSeen,
    (state.recArtist?.name || '').toLowerCase(),
  ]);
  const free = (name) => name && !excluded.has(name.toLowerCase());

  button.disabled = true;
  try {
    // Segundo nivel: relacionados de un relacionado al azar (así el resultado no sale de la lista visible).
    let candidates = [];
    const seeds = shuffle(state.recArtist?.similar || []);
    for (const seed of seeds.slice(0, 3)) {
      const info = await artistInfo(seed, 'similar');
      candidates = shuffle((info.items || []).map((i) => i.name).filter(free));
      if (candidates.length) break;
    }
    // Si no sale nada, relacionados de un artista de tu top al azar.
    if (!candidates.length && state.topArtists.length) {
      const info = await artistInfo(shuffle(state.topArtists)[0].name, 'similar');
      candidates = shuffle((info.items || []).map((i) => i.name).filter(free));
    }
    if (!candidates.length) {
      setStatus('No encuentro un artista nuevo por ahora. Prueba más tarde.', true);
      return;
    }
    const pick = candidates[0];
    blindSeen.add(pick.toLowerCase());
    setStatus(`Descubrimiento a ciegas: ${pick}`);
    await continueWithRelated(pick);
  } catch (err) {
    setStatus(err.message || 'No se ha podido descubrir un artista.', true);
  } finally {
    button.disabled = false;
  }
}

// Anti burbuja: elige un género que no aparece en tus géneros y reproduce un artista de él.
const BUBBLE_GENRES = ['rock', 'jazz', 'metal', 'reggae', 'blues', 'classical', 'folk', 'country', 'punk',
  'soul', 'funk', 'ambient', 'salsa', 'flamenco', 'disco', 'k-pop', 'indie', 'hip hop', 'techno', 'gospel', 'latin', 'bossa nova'];
async function antiBubble(button) {
  const mine = (state.genres || []).map((g) => g.genre.toLowerCase());
  const outside = BUBBLE_GENRES.filter((g) => !mine.some((m) => m.includes(g) || g.includes(m)));
  const shown = new Set((state.recArtist?.similar || []).map((n) => n.toLowerCase()));
  const excluded = new Set([
    ...(state.topArtists || []).map((x) => x.name.toLowerCase()),
    ...shown,
    ...blindSeen,
  ]);

  button.disabled = true;
  try {
    for (const tag of shuffle(outside).slice(0, 4)) {
      const res = await fetch(`/api/tag-artists?${new URLSearchParams({ tag })}`);
      const data = await res.json();
      if (data.configured === false) {
        state.lastfmOff = true;
        setStatus('Para la anti burbuja hace falta LASTFM_API_KEY en el .env.', true);
        return;
      }
      const names = shuffle((data.items || []).map((i) => i.name).filter((n) => !excluded.has(n.toLowerCase())));
      if (names.length) {
        const pick = names[0];
        blindSeen.add(pick.toLowerCase());
        setStatus(`Fuera de tu burbuja: ${tag} · ${pick}`);
        await continueWithRelated(pick);
        return;
      }
    }
    setStatus('No he encontrado un artista fuera de tu burbuja por ahora. Prueba más tarde.', true);
  } catch (err) {
    setStatus(err.message || 'No se ha podido buscar fuera de tu burbuja.', true);
  } finally {
    button.disabled = false;
  }
}

function renderRecs() {
  const box = $('recs');
  box.textContent = '';
  const r = state.recArtist;
  if (!r) {
    box.appendChild(emptyNote('Pon una canción o espera a que cargue tu top.'));
    return;
  }

  const head = document.createElement('div');
  head.className = 'section-head';
  const h = document.createElement('h3');
  h.textContent = `Más de ${r.name}`;
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'ghost small';
  play.textContent = 'Reproducir';
  play.disabled = r.loading || !r.tracks.length;
  play.addEventListener('click', () => playUris(r.tracks.map((t) => t.uri)));
  head.append(h, play);
  box.appendChild(head);

  const list = document.createElement('div');
  list.className = 'list';
  if (r.loading) list.appendChild(emptyNote(`Buscando canciones de ${r.name}…`));
  else if (!r.tracks.length) list.appendChild(emptyNote(r.note || 'Sin canciones por ahora.'));
  r.tracks.forEach((track, i) => {
    list.appendChild(trackRow(track, i + 1, () => playUris(r.tracks.slice(i).map((t) => t.uri))));
  });
  box.appendChild(list);

  // Tema aleatorio de este artista, debajo de la lista
  const random = document.createElement('button');
  random.type = 'button';
  random.className = 'ghost small';
  random.textContent = '🔀 Tema aleatorio';
  random.style.marginTop = '8px';
  random.disabled = r.loading || !r.tracks.length;
  random.addEventListener('click', () => randomArtistTrack(r.name, random));
  box.appendChild(random);

  if (r.similar && r.similar.length) {
    const sub = document.createElement('h3');
    sub.textContent = 'Artistas relacionados';
    const subHead = document.createElement('div');
    subHead.className = 'section-head';
    subHead.style.margin = '18px 0 8px';
    const blind = document.createElement('button');
    blind.type = 'button';
    blind.className = 'ghost small';
    blind.textContent = '🎲 A ciegas';
    blind.title = 'Descubrir un artista nuevo al azar y reproducir sus canciones';
    blind.addEventListener('click', () => discoverBlind(blind));
    const bubble = document.createElement('button');
    bubble.type = 'button';
    bubble.className = 'ghost small';
    bubble.textContent = '🫧 Anti burbuja';
    bubble.title = 'Descubrir un artista de un género que no escuchas';
    bubble.addEventListener('click', () => antiBubble(bubble));
    subHead.append(sub, blind, bubble);
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const name of r.similar) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip chip-btn';
      b.textContent = name;
      b.title = `Ver canciones de ${name}`;
      b.addEventListener('click', () => loadArtistRecs(name));
      chips.appendChild(b);
    }
    box.append(subHead, chips);
  }
}

/* ---------- Pantallas ---------- */
function showLogin(message) {
  $('main-view').style.display = 'none';
  $('login-view').style.display = '';
  $('login-status').textContent = message || '';
}

function showMain() {
  $('login-view').style.display = 'none';
  $('main-view').style.display = 'flex';
  initPlayer().catch((err) => setStatus(err.message, true));
  loadProfile();
  loadAll();
}

/* ---------- Eventos ---------- */
$('login-btn').addEventListener('click', () => {
  login().catch((e) => { $('login-status').textContent = e.message; });
});

$('range-bar').addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-range]');
  if (!btn || btn.dataset.range === state.range) return;
  state.range = btn.dataset.range;
  document.querySelectorAll('#range-bar button').forEach((b) => {
    b.classList.toggle('active', b === btn);
  });
  loadAll();
});

$('refresh-btn').addEventListener('click', () => loadAll());
$('top-play').addEventListener('click', () => {
  if (state.topTracks.length) playUris(state.topTracks.map((t) => t.uri));
});
const userControl = (action) => () => {
  state.lastUserAction = Date.now();
  action();
};
$('prev-btn').addEventListener('click', userControl(() => player?.previousTrack()));
$('toggle-btn').addEventListener('click', userControl(() => player?.togglePlay()));
$('next-btn').addEventListener('click', userControl(() => player?.nextTrack()));
// Barra de progreso: mientras arrastras no se mueve sola; al soltar, salta a ese punto.
const seek = $('seek');
seek.addEventListener('input', () => {
  state.dragging = true;
  $('t-cur').textContent = fmtTime(Number(seek.value));
});
seek.addEventListener('change', () => {
  state.dragging = false;
  state.lastUserAction = Date.now();
  player?.seek(Number(seek.value)).catch(() => { /* no crítico */ });
});

// Volumen
$('volume').addEventListener('input', () => {
  state.volume = Number($('volume').value) / 100;
  store.set('volume', String(state.volume));
  renderVolume();
  applyOutputVolume();
});

// Fundido entre canciones
$('fade-chk').addEventListener('change', (event) => setFade(event.target.checked));
$('fade-len').addEventListener('input', () => {
  state.fadeMs = Number($('fade-len').value) * 1000;
  store.set('fade_ms', String(state.fadeMs));
  renderFadeControls();
});

$('logout-btn').addEventListener('click', () => logout('Has cerrado sesión.'));

// Menú de perfil
$('profile-btn').addEventListener('click', (event) => {
  event.stopPropagation();
  toggleProfileMenu();
});
document.addEventListener('click', (event) => {
  if (!$('profile-wrap').contains(event.target)) toggleProfileMenu(false);
});
$('profile-login').addEventListener('click', () => {
  login().catch((e) => { setStatus(e.message, true); });
});
$('profile-logout').addEventListener('click', () => {
  toggleProfileMenu(false);
  logout('Has cerrado sesión.');
});

// Cuando la ficha ya está fijada arriba, pasa a fondo semitransparente con desenfoque.
window.addEventListener('scroll', () => {
  $('now').classList.toggle('stuck', window.scrollY > 60);
}, { passive: true });

/* ---------- Tema claro / oscuro ---------- */
function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('theme-toggle').textContent = light ? 'Tema oscuro' : 'Tema claro';
}
$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  store.set('theme', next);
  applyTheme(next);
});

/* ---------- Ventana emergente ---------- */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function openModal(title, fill) {
  $('modal-title').textContent = title;
  const body = $('modal-body');
  body.textContent = '';
  fill(body);
  $('modal').hidden = false;
  $('modal-close').focus();
}
function closeModal() {
  $('modal').hidden = true;
}
$('modal-close').addEventListener('click', closeModal);
$('modal').addEventListener('click', (event) => {
  if (event.target === $('modal')) closeModal();
});

/* ---------- Estadísticas ---------- */
function renderStats(body) {
  const list = Object.entries(statsData()).map(([id, s]) => ({ id, ...s }));
  if (!list.length) {
    body.appendChild(el('p', 'sub', 'Todavía no hay estadísticas. Una canción cuenta cuando supera los 30 segundos desde SpoDJ. Las estadísticas empiezan a contar desde esta versión.'));
    return;
  }

  const plays = list.reduce((sum, s) => sum + s.n, 0);
  const ms = list.reduce((sum, s) => sum + s.n * s.ms, 0);
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const artists = new Map();
  list.forEach((s) => artists.set(s.artist, (artists.get(s.artist) || 0) + s.n));

  const grid = el('div', 'stat-grid');
  [[plays, 'reproducciones'], [list.length, 'canciones distintas'], [artists.size, 'artistas'],
   [`${hours} h ${mins} min`, 'escuchando']].forEach(([value, label]) => {
    const box = el('div', 'stat');
    box.appendChild(el('b', null, String(value)));
    box.appendChild(el('span', null, label));
    grid.appendChild(box);
  });
  body.appendChild(grid);

  // Últimos 14 días
  body.appendChild(el('div', 'stats-h', 'Últimos 14 días'));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    days.push({ key, label: String(d.getDate()), count: list.reduce((sum, s) => sum + (s.days[key] || 0), 0) });
  }
  const max = Math.max(1, ...days.map((d) => d.count));
  const bars = el('div', 'bars');
  days.forEach((d) => {
    const col = el('div', 'col');
    col.title = `${d.key}: ${d.count} reproducciones`;
    const fill = el('div', 'fill');
    fill.style.height = `${Math.round((d.count / max) * 100)}%`;
    if (!d.count) fill.style.opacity = '0.25';
    col.appendChild(fill);
    col.appendChild(el('span', 'lbl', d.label));
    bars.appendChild(col);
  });
  body.appendChild(bars);

  const rank = (title, rows) => {
    body.appendChild(el('div', 'stats-h', title));
    const ol = el('ol', 'rank-list');
    rows.slice(0, 10).forEach((r) => {
      const li = el('li');
      li.appendChild(el('span', 'n', `${r.n}×`));
      const nm = el('span', 'nm', r.name);
      if (r.sub) nm.appendChild(el('small', null, `  ${r.sub}`));
      li.appendChild(nm);
      ol.appendChild(li);
    });
    body.appendChild(ol);
  };
  rank('Canciones más reproducidas', [...list].sort((a, b) => b.n - a.n).map((s) => ({ n: s.n, name: s.name, sub: s.artist })));
  rank('Artistas más reproducidos', [...artists].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ n, name: name || '—' })));

  const foot = el('div', 'modal-foot');
  const clear = el('button', 'ghost small', 'Borrar estadísticas');
  clear.type = 'button';
  clear.addEventListener('click', () => {
    if (!window.confirm('¿Borrar las estadísticas y los contadores de reproducciones de SpoDJ?')) return;
    store.del('stats');
    store.del('plays');
    state.counted = new Set();
    openModal('Estadísticas', renderStats);
  });
  foot.appendChild(clear);
  body.appendChild(foot);
}
$('open-stats').addEventListener('click', () => {
  toggleProfileMenu(false);
  openModal('Estadísticas', renderStats);
});

/* ---------- Atajos de teclado ---------- */
const SHORTCUTS = [
  ['Espacio', 'Reproducir / pausar'],
  ['→', 'Siguiente canción'],
  ['←', 'Canción anterior'],
  ['↑ / ↓', 'Subir / bajar volumen'],
  ['F', 'Activar / desactivar fundido'],
  ['?  o  H', 'Abrir esta ayuda'],
  ['Esc', 'Cerrar ventanas'],
];
function renderHelp(body) {
  const table = el('table', 'shortcuts');
  SHORTCUTS.forEach(([keys, what]) => {
    const tr = document.createElement('tr');
    const td1 = el('td');
    keys.split('  o  ').forEach((k, i) => {
      if (i) td1.appendChild(document.createTextNode(' o '));
      td1.appendChild(el('span', 'kbd', k));
    });
    tr.appendChild(td1);
    tr.appendChild(el('td', null, what));
    table.appendChild(tr);
  });
  body.appendChild(table);
  body.appendChild(el('p', 'sub', 'Los atajos no se activan mientras escribes en un campo de texto o mueves un deslizador.'));
}
function openHelp() {
  openModal('Atajos de teclado', renderHelp);
}
$('open-help').addEventListener('click', () => {
  toggleProfileMenu(false);
  openHelp();
});

function changeVolume(delta) {
  state.volume = Math.max(0, Math.min(1, Math.round((state.volume + delta) * 100) / 100));
  store.set('volume', String(state.volume));
  renderVolume();
  applyOutputVolume();
}

// Atajos globales. No actúan si el foco está en un campo de texto o un deslizador.
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Escape') {
    if (!$('modal').hidden) closeModal();
    return;
  }
  if (!$('modal').hidden) return;
  const t = event.target;
  if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;

  switch (event.key) {
    case ' ':
    case 'Spacebar':
      event.preventDefault();
      state.lastUserAction = Date.now();
      player?.togglePlay();
      break;
    case 'ArrowRight':
      event.preventDefault();
      state.lastUserAction = Date.now();
      player?.nextTrack();
      break;
    case 'ArrowLeft':
      event.preventDefault();
      state.lastUserAction = Date.now();
      player?.previousTrack();
      break;
    case 'ArrowUp':
      event.preventDefault();
      changeVolume(0.05);
      break;
    case 'ArrowDown':
      event.preventDefault();
      changeVolume(-0.05);
      break;
    case 'f':
    case 'F':
      setFade(!state.fade);
      break;
    case '?':
    case 'h':
    case 'H':
      openHelp();
      break;
    default:
      break;
  }
});

/* ---------- Controles del sistema (Media Session) ---------- */
// Teclas multimedia del teclado, controles del sistema y pantalla de bloqueo del móvil.
let mediaTrackId = null;
function setupMediaActions() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const act = (name, fn) => {
    try { navigator.mediaSession.setActionHandler(name, fn); } catch { /* acción no soportada */ }
  };
  act('play', () => { state.lastUserAction = Date.now(); player?.resume(); });
  act('pause', () => { state.lastUserAction = Date.now(); player?.pause(); });
  act('previoustrack', () => { state.lastUserAction = Date.now(); player?.previousTrack(); });
  act('nexttrack', () => { state.lastUserAction = Date.now(); player?.nextTrack(); });
  act('seekto', (details) => {
    if (details.seekTime == null) return;
    state.lastUserAction = Date.now();
    player?.seek(details.seekTime * 1000).catch(() => { /* no crítico */ });
  });
}
function updateMediaSession(t, paused, position, duration) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !t) return;
  if (t.id && t.id !== mediaTrackId) {
    mediaTrackId = t.id;
    const images = (t.album?.images || []).map((i) => ({
      src: i.url,
      sizes: `${i.width || 640}x${i.height || 640}`,
      type: 'image/jpeg',
    }));
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.name,
      artist: (t.artists || []).map((a) => a.name).join(', '),
      album: t.album?.name || '',
      artwork: images,
    });
  }
  navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
  if (duration > 0 && navigator.mediaSession.setPositionState) {
    try {
      navigator.mediaSession.setPositionState({
        duration: duration / 1000,
        playbackRate: 1,
        position: Math.min(position, duration) / 1000,
      });
    } catch { /* posición no soportada */ }
  }
}

/* ---------- Instalación como app (PWA) ---------- */
// Registra el service worker: permite instalar SpoDJ y abrirla sin barra del navegador.
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* sin instalación offline */ });
  });
}

/* ---------- Arranque ---------- */
(async function init() {
  loadPrefs();
  renderVolume();
  renderFadeControls();
  renderProfile();
  renderAccentPicker();
  applyTheme(store.get('theme') || 'dark');
  setupMediaActions();
  renderHistory();
  if (state.fade) startFade();
  try {
    config = await (await fetch('/config')).json();
  } catch {
    showLogin('No se puede contactar con el servidor. ¿Está arrancado con npm start?');
    return;
  }
  try {
    await handleCallback();
  } catch (err) {
    showLogin(err.message);
    return;
  }
  if (!store.get('refresh_token')) {
    showLogin();
    return;
  }
  if (store.get('scopes') !== SCOPES) {
    logout('Hemos ampliado los permisos de la app. Vuelve a conectar con Spotify.');
    return;
  }
  showMain();
})();