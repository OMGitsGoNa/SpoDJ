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

  // Ritmo: escuchas por hora del día y mapa semanal (día de la semana x hora).
  const r = rhythmData();
  r.hours = Array.isArray(r.hours) && r.hours.length === 24 ? r.hours : Array(24).fill(0);
  r.heat = Array.isArray(r.heat) && r.heat.length === 7 ? r.heat : Array.from({ length: 7 }, () => Array(24).fill(0));
  const now = new Date();
  r.hours[now.getHours()] += 1;
  r.heat[(now.getDay() + 6) % 7][now.getHours()] += 1;
  store.set('rhythm', JSON.stringify(r));
}

function rhythmData() {
  try { return JSON.parse(store.get('rhythm') || '{}') || {}; } catch { return {}; }
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

// Cola de peticiones a Spotify: una cada vez, con una pausa mínima entre ellas.
// Así no se acumulan peticiones en paralelo y no superamos el límite de la cuenta de desarrollo
// (Spotify no publica la cifra exacta; usa una ventana móvil de 30 s y devuelve 429 al pasarse).
const SPOTIFY_GAP_MS = 300; // ~100 peticiones por ventana de 30 s como máximo
const spotifyQueue = { tail: Promise.resolve(), last: 0 };
function enqueueSpotify(task) {
  const run = spotifyQueue.tail.then(async () => {
    const wait = Math.max(spotifyQueue.last + SPOTIFY_GAP_MS - Date.now(), 0);
    if (wait > 0) await sleep(wait);
    spotifyQueue.last = Date.now();
    return task();
  });
  spotifyQueue.tail = run.catch(() => {}); // un fallo no bloquea la cola
  return run;
}

async function api(path, options = {}) {
  const token = await getToken();
  return enqueueSpotify(() => fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  }));
}

// GET con reintento si Spotify limita las peticiones y mensajes de error claros.
async function apiJson(path) {
  const res = await api(path);
  if (res.status === 401) {
    logout('Tu sesión ha caducado. Conéctate de nuevo.');
    throw new Error('Sesión caducada');
  }
  if (res.status === 403) {
    throw new Error('Spotify ha denegado el acceso (403). Revisa que tu cuenta esté en "User management" de tu app del Dashboard.');
  }
  if (res.status === 429) {
    console.warn('[SpoDJ] 429 en', path, '| Retry-After:', res.headers.get('Retry-After'));
    const err = new Error('Spotify ha limitado las peticiones. Pulsa Reintentar en un momento.');
    err.status = 429;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Spotify respondió con un error (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return res.json();
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
async function playUris(uris, positionMs = 0) {
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
    body: JSON.stringify(positionMs > 0 ? { uris, position_ms: Math.round(positionMs) } : { uris }),
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
    // Sin canción sonando no cargamos recomendaciones: se piden al reproducir algo.
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

// Repetir canción: antes de que termine, si el botón está activo, se vuelve a poner la misma
// canción (aquí es cuando se consulta a la API). Así no llega a pasar a la siguiente.
function checkRepeat(t, st, paused) {
  if (!t?.id || !st.duration) return;
  if (st.position < st.duration - 3000) { state.repeatFiredId = null; return; }
  if (!state.repeatOne || paused || st.position >= st.duration) return;
  if (state.repeatFiredId === t.id) return;
  state.repeatFiredId = t.id;
  playUris([`spotify:track:${t.id}`]);
}

/* ---------- Continuar donde lo dejaste ---------- */
// Guarda la canción y la posición cada 5 s (y al pausar), en el navegador.
// Si al volver no hay nada sonando, se ofrece "Continuar" durante 7 días.
const RESUME_MAX_AGE_MS = 7 * 86400000;

function saveResume(t, st, paused) {
  if (!t?.id || !st.duration) return;
  if (st.position >= st.duration - 5000) { store.del('resume'); return; }
  const now = Date.now();
  if (now - (state.resumeSavedAt || 0) < 5000 && paused === state.resumePaused) return;
  state.resumeSavedAt = now;
  state.resumePaused = paused;
  store.set('resume', JSON.stringify({
    uri: `spotify:track:${t.id}`,
    name: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    position: st.position,
    duration: st.duration,
    at: now,
  }));
}

function readResume() {
  try {
    const r = JSON.parse(store.get('resume') || 'null');
    if (!r?.uri || Date.now() - r.at > RESUME_MAX_AGE_MS) return null;
    return r;
  } catch {
    return null;
  }
}

function renderResume() {
  const r = readResume();
  if (!r || state.currentId) { $('resume').hidden = true; return; }
  $('resume-text').textContent = `Última: ${r.name} · ${fmtTime(r.position)}`;
  $('resume').hidden = false;
}
function hideResume() {
  $('resume').hidden = true;
}
$('resume-btn').addEventListener('click', () => {
  const r = readResume();
  if (r) playUris([r.uri], r.position || 0);
});

/* ---------- Avisos del sistema al cambiar de canción ---------- */
// Solo avisa si la app está en segundo plano (pestaña oculta o PWA minimizada).
function notifyOn() {
  return store.get('notify') === '1';
}
function renderNotifyBtn() {
  $('notify-toggle').textContent = notifyOn() ? 'Avisos: activados' : 'Avisos: desactivados';
}
async function toggleNotify() {
  if (notifyOn()) {
    store.set('notify', '0');
    renderNotifyBtn();
    return;
  }
  if (!('Notification' in window)) {
    setStatus('Este navegador no permite avisos.', true);
    return;
  }
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') {
    setStatus('Sin permiso, no se pueden mostrar avisos.', true);
    return;
  }
  store.set('notify', '1');
  renderNotifyBtn();
}
$('notify-toggle').addEventListener('click', toggleNotify);

function notifyTrack(t) {
  if (!notifyOn() || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = {
    body: (t.artists || []).map((a) => a.name).join(', '),
    icon: t.album?.images?.[0]?.url || '/favicon.ico',
    tag: 'spodj-now', // el aviso nuevo sustituye al anterior
    silent: true,
  };
  const fallback = () => { try { new Notification(t.name, opts); } catch { /* sin aviso */ } };
  if (navigator.serviceWorker?.ready) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(t.name, opts)).catch(fallback);
  } else {
    fallback();
  }
}

/* ---------- Progreso en el icono de la pestaña ---------- */
// Mientras suena una canción, el icono muestra un anillo con el avance. Al pausar, vuelve el original.
const FAV_HREF = '/favicon.ico';
let favKey = null;
function updateFavicon(pos, dur, paused) {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  if (paused || !dur) {
    if (favKey !== null) { link.href = FAV_HREF; favKey = null; }
    return;
  }
  const ratio = Math.min(1, Math.max(0, pos / dur));
  const key = Math.round(ratio * 60); // se redibuja solo cuando cambia de forma visible
  if (key === favKey) return;
  favKey = key;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#3a3a3a';
  ctx.beginPath();
  ctx.arc(32, 32, 24, 0, Math.PI * 2);
  ctx.stroke();
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1ed760';
  ctx.strokeStyle = accent;
  ctx.beginPath();
  ctx.arc(32, 32, 24, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
  ctx.stroke();
  link.href = c.toDataURL('image/png');
}


/* ---------- Extras: brillo, repetir, vista compacta, pantalla completa, títulos largos, conexión ---------- */
// Títulos largos: si no caben, se desplazan despacio dentro de su caja.
function setMarquee(el, text) {
  el.dataset.full = text;
  el.classList.remove('marq-box');
  el.style.removeProperty('--shift');
  el.textContent = '';
  const inner = document.createElement('span');
  inner.textContent = text;
  el.appendChild(inner);
  requestAnimationFrame(() => {
    const over = inner.scrollWidth - el.clientWidth;
    if (over > 4) {
      el.style.setProperty('--shift', `-${over}px`);
      el.classList.add('marq-box');
    }
  });
}
window.addEventListener('resize', () => {
  ['track-title', 'track-artist'].forEach((id) => {
    const el = $(id);
    if (el.dataset.full) setMarquee(el, el.dataset.full);
  });
});

// Brillo del fondo: el deslizador del menú guarda el valor y se aplica al momento.
$('bg-level').addEventListener('input', (event) => {
  state.bgLevel = Number(event.target.value) / 100;
  store.set('bg_level', String(state.bgLevel));
  const img = $('bg-art');
  if (img.src && img.style.opacity !== '0') img.style.opacity = String(bgOpacity());
});


// Vista compacta (se recuerda en el navegador) para el top y el historial.
function applyCompact(listId, btnId, on) {
  $(listId).classList.toggle('compact', on);
  $(btnId).setAttribute('aria-pressed', String(on));
  $(btnId).title = on ? 'Vista compacta: activada' : 'Vista compacta: desactivada';
}
function toggleCompact(listId, btnId, key) {
  const on = !$(listId).classList.contains('compact');
  store.set(key, on ? '1' : '0');
  applyCompact(listId, btnId, on);
}
$('top-compact').addEventListener('click', () => toggleCompact('top-list', 'top-compact', 'top_compact'));
$('history-compact').addEventListener('click', () => toggleCompact('history-list', 'history-compact', 'history_compact'));

// Aviso claro cuando se corta la conexión a internet.
window.addEventListener('offline', () => setStatus('Sin conexión a internet. SpoDJ seguirá cuando vuelva la red.', true));
window.addEventListener('online', () => {
  setStatus('Conexión recuperada.');
  setTimeout(() => { if (navigator.onLine) setStatus(''); }, 3000);
});

const initUi = () => {
  renderNotifyBtn();
  renderResume();
  const savedBg = Number(store.get('bg_level'));
  if (store.get('bg_level') !== null && !Number.isNaN(savedBg)) {
    state.bgLevel = savedBg;
    $('bg-level').value = String(Math.round(savedBg * 100));
  }
  applyCompact('top-list', 'top-compact', store.get('top_compact') === '1');
  applyCompact('history-list', 'history-compact', store.get('history_compact') === '1');
  if (!navigator.onLine) setStatus('Sin conexión a internet. SpoDJ seguirá cuando vuelva la red.', true);
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUi);
else initUi();

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
    setMarquee($('track-title'), t.name);
    setMarquee($('track-artist'), t.artists.map((a) => a.name).join(', '));
    $('cover').src = t.album.images?.[0]?.url || '';
    applyNowColor(t.album.images?.[0]?.url || '');
    setBgArt(t.album.images?.[0]?.url || '');
    if (!$('screensaver').hidden) renderScreensaver();
    hideResume();
    notifyTrack(t);
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
  saveResume(t, st, paused);
  checkRepeat(t, st, paused);
  updateFavicon(st.position || 0, st.duration || 0, paused);

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
    const row = trackRow(track, 0, () => playUris(items.slice(i).map((t) => t.uri)));
    row.querySelector('.tg')?.remove(); // el historial no muestra género
    box.appendChild(row);
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
// Brillo de la portada de fondo: lo elige el usuario en el menú (por defecto 20 %).
function bgOpacity() {
  return state.bgLevel ?? 0.2;
}
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
  img.style.opacity = String(bgOpacity());
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
  img.style.opacity = String(bgOpacity() * out);
}
function restoreBgArt() {
  const img = $('bg-art');
  if (!img.dataset.src) return;
  img.style.transition = 'opacity .35s ease';
  img.style.opacity = String(bgOpacity());
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
  // Las comillas dentro del título o del artista rompen la búsqueda de Spotify
  const clean = (text) => String(text || '').replace(/"/g, '').trim();
  const q = `track:"${clean(title)}" artist:"${clean(artistName)}"`;
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
    for (const item of (top.items || []).slice(0, 8)) {
      let found = null;
      try {
        found = await findSpotifyTrack(item.name, item.artist || name);
      } catch (err) {
        if (err.status === 429) throw err; // si Spotify nos limita, paramos y lo mostramos
      }
      if (loadId !== state.recLoad) return;
      if (found && !tracks.some((t) => t.id === found.id)) {
        rememberTrack(found);
        tracks.push(found);
      }
      if (tracks.length >= 5) break;
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
  const profile = document.createElement('button');
  profile.type = 'button';
  profile.className = 'ghost small';
  profile.textContent = 'Perfil';
  profile.addEventListener('click', () => openArtistPanel(r.name, r.id));
  head.append(h, profile, play);
  box.appendChild(head);

  const list = document.createElement('div');
  list.className = 'list';
  if (r.loading) list.appendChild(emptyNote(`Buscando canciones de ${r.name}…`));
  else if (!r.tracks.length) {
    // Mensaje + botón para volver a pedir los datos de este artista
    const wrap = emptyNote(r.note || 'Sin canciones por ahora.');
    const retry = el('button', 'ghost small', 'Reintentar');
    retry.type = 'button';
    retry.style.marginLeft = '8px';
    retry.addEventListener('click', () => {
      state.recCache.delete(r.name); // descartamos el resultado anterior
      loadArtistRecs(r.name, r.id);
    });
    wrap.appendChild(retry);
    list.appendChild(wrap);
  }
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
    subHead.append(sub, blind);
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

// Repetir la canción actual: solo marca el botón. Al acercarse al final, checkRepeat decide.
$('repeat-btn').addEventListener('click', userControl(() => {
  state.repeatOne = !state.repeatOne;
  state.repeatFiredId = null;
  $('repeat-btn').setAttribute('aria-pressed', String(state.repeatOne));
  $('repeat-btn').title = state.repeatOne ? 'Repetir esta canción: activado' : 'Repetir esta canción: desactivado';
}));
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
function openModal(title, fill, wide = false) {
  $('modal-title').textContent = title;
  const body = $('modal-body');
  body.textContent = '';
  $('modal').querySelector('.modal-card').classList.toggle('wide', wide);
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

  const left = el('div', 'stats-col');
  const right = el('div', 'stats-col');
  const cols = el('div', 'stats-cols');
  cols.append(left, right);
  body.appendChild(cols);

  // Últimos 14 días
  left.appendChild(el('div', 'stats-h', 'Últimos 14 días'));
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
  left.appendChild(bars);

  const rank = (title, rows) => {
    right.appendChild(el('div', 'stats-h', title));
    const ol = el('ol', 'rank-list');
    rows.slice(0, 10).forEach((r) => {
      const li = el('li');
      li.appendChild(el('span', 'n', `${r.n}×`));
      const nm = el('span', 'nm', r.name);
      if (r.sub) nm.appendChild(el('small', null, `  ${r.sub}`));
      li.appendChild(nm);
      ol.appendChild(li);
    });
    right.appendChild(ol);
  };
  rank('Canciones más reproducidas', [...list].sort((a, b) => b.n - a.n).map((s) => ({ n: s.n, name: s.name, sub: s.artist })));
  rank('Artistas más reproducidos', [...artists].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ n, name: name || '—' })));

  renderStreak(left, list);
  renderYear(left, list);
  renderHourBars(left);
  renderHeatmap(body);

  const foot = el('div', 'modal-foot');
  const clear = el('button', 'ghost small danger-btn', 'Borrar estadísticas');
  clear.type = 'button';
  clear.addEventListener('click', () => {
    if (!window.confirm('¿Borrar las estadísticas y los contadores de reproducciones de SpoDJ?')) return;
    store.del('stats');
    store.del('plays');
    store.del('rhythm');
    state.counted = new Set();
    openModal('Estadísticas', renderStats, true);
  });
  foot.appendChild(clear);
  body.appendChild(foot);
}
/* Ritmo: escuchas por hora y mapa semanal (datos de la clave 'rhythm'). */
function renderHourBars(body) {
  const r = rhythmData();
  if (!Array.isArray(r.hours) || r.hours.length !== 24) return;
  body.appendChild(el('div', 'stats-h', 'Escuchas por hora'));
  const max = Math.max(1, ...r.hours);
  const bars = el('div', 'bars hours');
  r.hours.forEach((n, h) => {
    const col = el('div', 'col');
    col.title = `${String(h).padStart(2, '0')}:00 — ${n} reproducciones`;
    const fill = el('div', 'fill');
    fill.style.height = `${Math.round((n / max) * 100)}%`;
    if (!n) fill.style.opacity = '0.25';
    col.appendChild(fill);
    col.appendChild(el('span', 'lbl', h % 3 === 0 ? String(h) : ''));
    bars.appendChild(col);
  });
  body.appendChild(bars);
}

function renderHeatmap(body) {
  const r = rhythmData();
  if (!Array.isArray(r.heat) || r.heat.length !== 7) return;
  body.appendChild(el('div', 'stats-h', 'Mapa semanal (día × hora)'));
  const dayNames = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const max = Math.max(1, ...r.heat.flat());
  const grid = el('div', 'heat');
  dayNames.forEach((dn, di) => {
    grid.appendChild(el('span', 'hl', dn));
    for (let h = 0; h < 24; h++) {
      const v = (r.heat[di] && r.heat[di][h]) || 0;
      const cell = el('i', 'hc');
      cell.style.opacity = v ? String(0.15 + (0.85 * v) / max) : '0.06';
      cell.title = `${dn} ${String(h).padStart(2, '0')}:00 — ${v}`;
      grid.appendChild(cell);
    }
  });
  body.appendChild(grid);
}

/* Racha: días consecutivos con alguna reproducción. */
function dayNum(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
function keyFromNum(n) {
  const d = new Date(n * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function playedDays(list) {
  const set = new Set();
  list.forEach((s) => Object.entries(s.days || {}).forEach(([k, v]) => { if (v > 0) set.add(k); }));
  return set;
}
function renderStreak(body, list) {
  const set = playedDays(list);
  if (!set.size) return;
  const nums = [...set].map(dayNum).sort((a, b) => a - b);
  let longest = 1;
  let run = 1;
  for (let i = 1; i < nums.length; i++) {
    run = nums[i] === nums[i - 1] + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const today = dayNum(dayKey(new Date()));
  // La racha actual puede empezar hoy o ayer (si hoy aún no hay escuchas).
  let start = set.has(keyFromNum(today)) ? today : today - 1;
  let current = 0;
  while (set.has(keyFromNum(start - current))) current++;

  body.appendChild(el('div', 'stats-h', 'Racha'));
  const row = el('div', 'stat-grid streak-row');
  [[current, 'días seguidos ahora'], [longest, 'racha más larga'], [set.size, 'días con música']].forEach(([value, label]) => {
    const box = el('div', 'stat');
    box.appendChild(el('b', null, String(value)));
    box.appendChild(el('span', null, label));
    row.appendChild(box);
  });
  body.appendChild(row);
}

/* Año en SpoDJ: resumen de un año, descargable como imagen. */
function yearStats(list, year) {
  const prefix = `${year}-`;
  const rows = list.map((s) => {
    let n = 0;
    Object.entries(s.days || {}).forEach(([k, v]) => { if (k.startsWith(prefix)) n += v; });
    return { name: s.name || '—', artist: s.artist || '—', n, ms: n * (s.ms || 0) };
  }).filter((r) => r.n > 0);
  const artists = new Map();
  rows.forEach((r) => artists.set(r.artist, (artists.get(r.artist) || 0) + r.n));
  const activeDays = [...playedDays(list)].filter((k) => k.startsWith(prefix)).length;
  return {
    plays: rows.reduce((sum, r) => sum + r.n, 0),
    ms: rows.reduce((sum, r) => sum + r.ms, 0),
    tracks: [...rows].sort((a, b) => b.n - a.n).slice(0, 5),
    artists: [...artists].sort((a, b) => b[1] - a[1]).slice(0, 5),
    distinct: rows.length,
    activeDays,
  };
}
function formatHM(ms) {
  return `${Math.floor(ms / 3600000)} h ${Math.floor((ms % 3600000) / 60000)} min`;
}
function renderYear(body, list) {
  const years = [...new Set([...playedDays(list)].map((k) => k.slice(0, 4)))].sort().reverse();
  if (!years.length) return;
  body.appendChild(el('div', 'stats-h', 'Resumen anual'));
  const head = el('div', 'year-head');
  const select = el('select');
  years.forEach((y) => select.appendChild(el('option', null, y)));
  const box = el('div');
  const draw = () => {
    box.textContent = '';
    fillYear(box, list, select.value);
  };
  select.addEventListener('change', draw);
  head.appendChild(select);
  body.appendChild(head);
  body.appendChild(box);
  draw();
}
function fillYear(box, list, year) {
  const y = yearStats(list, year);
  if (!y.plays) {
    box.appendChild(el('p', 'sub', `No hay reproducciones registradas en ${year}.`));
    return;
  }
  const grid = el('div', 'stat-grid');
  [[y.plays, 'reproducciones'], [y.distinct, 'canciones distintas'], [y.activeDays, 'días con música'], [formatHM(y.ms), 'escuchando']].forEach(([value, label]) => {
    const s = el('div', 'stat');
    s.appendChild(el('b', null, String(value)));
    s.appendChild(el('span', null, label));
    grid.appendChild(s);
  });
  box.appendChild(grid);
  const ol = el('ol', 'rank-list');
  y.tracks.forEach((r) => {
    const li = el('li');
    li.appendChild(el('span', 'n', `${r.n}×`));
    const nm = el('span', 'nm', r.name);
    nm.appendChild(el('small', null, `  ${r.artist}`));
    li.appendChild(nm);
    ol.appendChild(li);
  });
  box.appendChild(ol);
}
$('open-stats').addEventListener('click', () => {
  toggleProfileMenu(false);
  openModal('Estadísticas', renderStats, true);
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

/* ---------- Salvapantallas del reproductor ---------- */
// Tras 30 s sin mover el ratón (ni pulsar nada) y con una canción sonando, aparece el reproductor a pantalla completa.
const IDLE_MS = 30000;
let lastActivity = Date.now();
const markActivity = () => {
  lastActivity = Date.now();
  // Si el ratón se mueve, vuelve a verse
  $('screensaver').classList.remove('ss-hide-cursor');
};
['mousemove', 'pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((ev) =>
  window.addEventListener(ev, markActivity, { passive: true }));

const artistPhotoCache = new Map();
async function artistPhotoFor(name, id) {
  const key = (id || name || '').toLowerCase();
  if (!name) return '';
  if (artistPhotoCache.has(key)) return artistPhotoCache.get(key);
  const top = (state.topArtists || []).find((a) => (id && a.id === id) || a.name.toLowerCase() === name.toLowerCase());
  let url = top?.images?.[0]?.url || '';
  if (!url) {
    try {
      const found = await apiJson(`/search?${new URLSearchParams({ q: `artist:"${name}"`, type: 'artist', limit: '1' })}`);
      url = found.artists?.items?.[0]?.images?.[0]?.url || '';
    } catch { /* sin foto */ }
  }
  artistPhotoCache.set(key, url);
  return url;
}

function renderScreensaver() {
  const t = state.trackInfo.get(state.currentId);
  const main = t?.artists?.[0] || { id: null, name: ($('track-artist').textContent || '').split(',')[0].trim() };
  $('ss-cover').src = $('cover').src || '';
  $('ss-title').textContent = $('track-title').textContent;
  $('ss-artist-name').textContent = main.name || '';
  const img = $('ss-artist-img');
  img.hidden = true;
  artistPhotoFor(main.name, main.id).then((url) => {
    if ($('ss-artist-name').textContent !== (main.name || '')) return; // respuesta vieja
    img.src = url || '';
    img.hidden = !url;
  });
}
function openScreensaver() {
  renderScreensaver();
  $('screensaver').hidden = false;
  $('screensaver').classList.add('ss-hide-cursor');
  document.documentElement.classList.add('ss-open'); // bloquea el scroll de la web mientras está activo
}
function closeScreensaver() {
  $('screensaver').hidden = true;
  $('screensaver').classList.remove('ss-hide-cursor');
  document.documentElement.classList.remove('ss-open');
  lastActivity = Date.now(); // no vuelve a salir hasta otros 30 s sin actividad
}
$('ss-close').addEventListener('click', closeScreensaver);
$('screensaver').addEventListener('click', (event) => {
  if (event.target === $('screensaver')) markActivity();
});

setInterval(() => {
  if (!$('screensaver').hidden) return;
  const playing = state.lastTick && !state.lastTick.paused;
  if (playing && Date.now() - lastActivity >= IDLE_MS) openScreensaver();
}, 1000);

// Barra de tiempo solo visual (sin manejador): avanza con la posición estimada
setInterval(() => {
  if ($('screensaver').hidden) return;
  const p = estimatedPosition();
  if (p && p.duration) $('ss-fill').style.width = `${Math.min(100, (p.position / p.duration) * 100)}%`;
}, 500);

/* ---------- Perfil de artista (panel de la izquierda) ---------- */
let artistPanelSeq = 0;
const artistPanelCache = new Map(); // id o nombre -> { at, artist }
const ARTIST_PANEL_TTL = 10 * 60 * 1000;
function closeArtistPanel() {
  artistPanelSeq++;
  $('artist-panel').classList.remove('open');
}
// Solo información del artista: una petición a Spotify (y la caché de 10 minutos).
async function openArtistPanel(name, id = null) {
  if (!name) return;
  const seq = ++artistPanelSeq;
  $('artist-panel').classList.add('open');
  $('ap-name').textContent = name;
  const info = $('ap-info');
  info.textContent = '';
  info.appendChild(emptyNote('Cargando información del artista…'));

  const top = (state.topArtists || []).find((a) => (id && a.id === id) || a.name.toLowerCase() === name.toLowerCase());
  const cacheKey = (id || name).toLowerCase();
  const cached = artistPanelCache.get(cacheKey);
  let artist = cached && Date.now() - cached.at < ARTIST_PANEL_TTL ? cached.artist : top;

  try {
    if (!artist || !artist.followers) {
      if (id) artist = await apiJson(`/artists/${id}`);
      else {
        const found = await apiJson(`/search?${new URLSearchParams({ q: `artist:"${name}"`, type: 'artist', limit: '1' })}`);
        artist = found.artists?.items?.[0] || top;
      }
      if (!artist) throw new Error('No he encontrado este artista en Spotify.');
      artistPanelCache.set(cacheKey, { at: Date.now(), artist });
    }
    if (seq !== artistPanelSeq) return;
    renderArtistInfo(artist, top, name);
  } catch (err) {
    if (seq !== artistPanelSeq) return;
    if (top) renderArtistInfo(top, top, name);
    else {
      info.textContent = '';
      info.appendChild(emptyNote(err.message || 'No se ha podido cargar el artista.'));
    }
  }
}

// Spotify no da los "oyentes mensuales"; Last.fm sí da sus oyentes, que es lo que mostramos.
async function loadArtistListeners(name) {
  const value = $('ap-listeners');
  if (!value) return;
  try {
    const res = await fetch(`/api/artist-stats?${new URLSearchParams({ artist: name })}`);
    const data = await res.json();
    // Si el panel ya muestra otro artista, esta respuesta llega tarde y no se pinta
    if ($('ap-listeners') !== value) return;
    if (data.configured === false) value.textContent = 'Falta LASTFM_API_KEY';
    else if (data.error) value.textContent = '—';
    else value.textContent = Number(data.listeners || 0).toLocaleString('es-ES');
  } catch {
    value.textContent = '—';
  }
}

function renderArtistInfo(artist, top, name) {
  const img = $('ap-img');
  const pic = artist.images?.[0]?.url || top?.images?.[0]?.url || '';
  img.src = pic;
  img.hidden = !pic;
  const genres = artist.genres?.length ? artist.genres : (top?.genres || []);
  $('ap-genres').textContent = genres.length ? genres.slice(0, 4).join(' · ') : 'Sin géneros en Spotify';
  $('ap-name').textContent = artist.name || name;

  const info = $('ap-info');
  info.textContent = '';
  const grid = el('div', 'stat-grid');
  const followers = artist.followers?.total;
  const listenersBox = el('div', 'stat');
  const listenersValue = el('b', null, '…');
  listenersValue.id = 'ap-listeners';
  listenersBox.append(listenersValue, el('span', null, 'Oyentes (Last.fm)'));
  const followersBox = el('div', 'stat');
  followersBox.append(
    el('b', null, followers != null ? followers.toLocaleString('es-ES') : '—'),
    el('span', null, 'Seguidores en Spotify'),
  );
  grid.append(followersBox, listenersBox);
  info.appendChild(grid);
  loadArtistListeners(name);

  const url = artist.external_urls?.spotify;
  if (url) {
    const link = el('a', 'ap-link', 'Abrir perfil en Spotify');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    info.appendChild(link);
  }
}
$('ap-close').addEventListener('click', closeArtistPanel);
$('track-artist').addEventListener('click', () => {
  const t = state.trackInfo.get(state.currentId);
  const first = t?.artists?.[0];
  if (first?.name) openArtistPanel(first.name, first.id);
});

// Atajos globales. No actúan si el foco está en un campo de texto o un deslizador.
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Escape') {
    if (!$('modal').hidden) closeModal();
    else if (!$('screensaver').hidden) closeScreensaver();
    else closeArtistPanel();
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