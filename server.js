import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
// En tu PC escucha solo en 127.0.0.1. En Render (variable RENDER presente) escucha en 0.0.0.0.
// HOST permite forzar otro valor si hace falta.
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;

if (!CLIENT_ID) {
  console.error('Falta SPOTIFY_CLIENT_ID. Revisa tu archivo .env.');
  process.exit(1);
}

const app = express();

// La web pide aquí la configuración pública (en PKCE el Client ID no es un secreto).
app.get('/config', (_req, res) => {
  res.json({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
});

// Spotify redirige aquí tras el login; la misma página gestiona el código.
app.get('/callback', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ---------- Géneros de respaldo con Last.fm ----------
   La clave vive solo en el servidor (.env, LASTFM_API_KEY). Si no está,
   la app sigue funcionando; simplemente no hay géneros de respaldo. */
const LASTFM_KEY = process.env.LASTFM_API_KEY || '';
const tagCache = new Map();
// Etiquetas de Last.fm que describen otra cosa que el género
const NOT_GENRES = /^(seen live|favou?rites?|male vocalists?|female vocalists?|beautiful|awesome|love|cool|good|great|spotify|all|albums? i own|under \d+ listeners)$/i;

app.get('/api/tags', async (req, res) => {
  const artist = String(req.query.artist || '').trim().slice(0, 120);
  if (!artist) return res.json({ tags: [], configured: Boolean(LASTFM_KEY) });
  if (!LASTFM_KEY) return res.json({ tags: [], configured: false });
  if (tagCache.has(artist)) return res.json({ tags: tagCache.get(artist), configured: true });

  try {
    const params = new URLSearchParams({
      method: 'artist.gettoptags',
      artist,
      autocorrect: '1',
      api_key: LASTFM_KEY,
      format: 'json',
    });
    const response = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    const data = await response.json();
    // Last.fm devuelve 200 con un campo "error" si la clave no vale o el artista no existe
    if (data.error && data.error !== 6) {
      console.error('Last.fm respondió con error:', data.error, data.message);
      return res.json({ tags: [], configured: true, error: true, message: data.message });
    }
    const tags = (data.toptags?.tag || [])
      .map((t) => String(t.name || '').toLowerCase())
      .filter((name) => name && !NOT_GENRES.test(name) && !/\d/.test(name))
      .slice(0, 3);
    tagCache.set(artist, tags); // solo se guardan respuestas válidas, no errores
    res.json({ tags, configured: true });
  } catch (err) {
    console.error('Last.fm no responde:', err?.message);
    res.json({ tags: [], configured: true, error: true });
  }
});

// Canciones más escuchadas de un artista (kind=tracks) o artistas relacionados (kind=similar)
const infoCache = new Map();
app.get('/api/artist-info', async (req, res) => {
  const artist = String(req.query.artist || '').trim().slice(0, 120);
  const kind = req.query.kind === 'similar' ? 'similar' : 'tracks';
  if (!artist) return res.json({ items: [], configured: Boolean(LASTFM_KEY) });
  if (!LASTFM_KEY) return res.json({ items: [], configured: false });

  const key = `${kind}:${artist.toLowerCase()}`;
  if (infoCache.has(key)) return res.json({ items: infoCache.get(key), configured: true });

  try {
    const params = new URLSearchParams({
      method: kind === 'similar' ? 'artist.getsimilar' : 'artist.gettoptracks',
      artist,
      autocorrect: '1',
      limit: kind === 'similar' ? '6' : '8',
      api_key: LASTFM_KEY,
      format: 'json',
    });
    const response = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    const data = await response.json();
    if (data.error && data.error !== 6) {
      return res.json({ items: [], configured: true, error: true, message: data.message });
    }
    const items = kind === 'similar'
      ? (data.similarartists?.artist || []).map((a) => ({ name: String(a.name || '') })).filter((a) => a.name)
      : (data.toptracks?.track || []).map((t) => ({ name: String(t.name || ''), artist: String(t.artist?.name || artist) })).filter((t) => t.name);
    infoCache.set(key, items);
    res.json({ items, configured: true });
  } catch (err) {
    console.error('Last.fm no responde:', err?.message);
    res.json({ items: [], configured: true, error: true });
  }
});

// Artistas más escuchados de una etiqueta (género), para la sección "anti burbuja"
const tagArtistCache = new Map();
app.get('/api/tag-artists', async (req, res) => {
  const tag = String(req.query.tag || '').trim().toLowerCase().slice(0, 60);
  if (!tag) return res.json({ items: [], configured: Boolean(LASTFM_KEY) });
  if (!LASTFM_KEY) return res.json({ items: [], configured: false });
  if (tagArtistCache.has(tag)) return res.json({ items: tagArtistCache.get(tag), configured: true });

  try {
    const params = new URLSearchParams({
      method: 'tag.gettopartists',
      tag,
      limit: '10',
      api_key: LASTFM_KEY,
      format: 'json',
    });
    const response = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    const data = await response.json();
    if (data.error && data.error !== 6) {
      return res.json({ items: [], configured: true, error: true, message: data.message });
    }
    const items = (data.topartists?.artist || []).map((a) => ({ name: String(a.name || '') })).filter((a) => a.name);
    tagArtistCache.set(tag, items);
    res.json({ items, configured: true });
  } catch (err) {
    console.error('Last.fm no responde:', err?.message);
    res.json({ items: [], configured: true, error: true });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, HOST, () => {
  console.log(`SpoDJ escuchando en ${HOST}:${PORT}`);
});