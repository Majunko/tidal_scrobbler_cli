import { sleep, updateEnvVariable, printSameLine, chunkArray } from './utils.js';

export const API_BASE_URL = 'https://openapi.tidal.com/v2';

const clientId = process.env.TIDAL_CLIENT_ID;
const clientSecret = process.env.TIDAL_CLIENT_SECRET;

let accessToken = process.env.TIDAL_ACCESS_TOKEN;
let refreshToken = process.env.TIDAL_REFRESH_TOKEN;

let headers = {
  Accept: 'application/vnd.api+json',
  Authorization: `Bearer ${accessToken}`,
};

let tokenTries = 0;
let refreshPromise = null;

// Global rate limiter. Tidal throttles with 429s but sends no rate-limit headers,
// so we use a conservative token bucket. It starts EMPTY (no initial burst) and
// sustains a steady 2 requests/second, which stays well within Tidal's limits
// even after long runs. A 429 is retried silently with the server's Retry-After.
const RATE_LIMIT_CAPACITY = 3;
const RATE_LIMIT_REFILL_PER_SEC = 2;
let bucket = { tokens: 0, last: Date.now() };

let requestCount = 0;

export const getRequestCount = () => requestCount;

async function acquireToken() {
  while (true) {
    const now = Date.now();
    bucket.tokens = Math.min(
      RATE_LIMIT_CAPACITY,
      bucket.tokens + ((now - bucket.last) / 1000) * RATE_LIMIT_REFILL_PER_SEC
    );
    bucket.last = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    await sleep(50);
  }
}

async function doRefresh() {
  const url = 'https://auth.tidal.com/v1/oauth2/token';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to refresh token. HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  updateEnvVariable('TIDAL_ACCESS_TOKEN', data.access_token);
  if (data.refresh_token) {
    updateEnvVariable('TIDAL_REFRESH_TOKEN', data.refresh_token);
  }
  accessToken = data.access_token;
  refreshToken = data.refresh_token || refreshToken;
  headers.Authorization = `Bearer ${accessToken}`;
  tokenTries = 0;
  return accessToken;
}

// Deduplicates concurrent refresh calls.
export async function refreshTidalAccessToken() {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function tidalFetch(path, { method = 'GET', body = null, retries = 0 } = {}) {
  await acquireToken();
  requestCount++;

  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;
  const options = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
    options.headers = { ...headers, 'Content-Type': 'application/vnd.api+json' };
  }

  const response = await fetch(url, options);

  switch (response.status) {
    case 200:
      return response.json();
    case 201:
      return response.json().catch(() => null);
    case 204:
      return null;
    case 401:
      if (tokenTries >= 3) {
        throw new Error('Access token refresh failed too many times.');
      }
      tokenTries++;
      await refreshTidalAccessToken();
      return tidalFetch(path, { method, body, retries });
    case 429:
      if (retries >= 6) {
        throw new Error('Rate limited by Tidal for too long.');
      }
      bucket.tokens = 0; // Back off the whole pool
      bucket.last = Date.now();
      const retryAfter = parseInt(response.headers.get('Retry-After')) || 2;
      await sleep(retryAfter * 1000 * (retries + 1)); // Exponential backoff, silent
      return tidalFetch(path, { method, body, retries: retries + 1 });
    default:
      let detail = '';
      try {
        const err = await response.json();
        detail = (err.errors && err.errors.map((e) => e.detail).filter(Boolean).join('; ')) ||
          JSON.stringify(err).slice(0, 300);
      } catch {
        // ignore parse errors
      }
      throw new Error(`HTTP error! status: ${response.status} ${detail}`.trim());
  }
}

/**
 * Searches Tidal for tracks matching a query and returns normalized candidates:
 * [{ id, title, version, fullTitle, artists }]
 */
export async function searchTracks(query) {
  const path = `/searchResults?filter[query]=${encodeURIComponent(query)}&countryCode=US&locale=en-US&include=tracks.artists`;
  const data = await tidalFetch(path);

  const artistMap = new Map();
  for (const entry of data?.included || []) {
    if (entry.type === 'artists') {
      artistMap.set(String(entry.id), entry.attributes?.name || '');
    }
  }

  const tracks = [];
  for (const entry of data?.included || []) {
    if (entry.type !== 'tracks') continue;
    const attrs = entry.attributes || {};
    const artistIds = entry.relationships?.artists?.data?.map((a) => a.id) || [];
    const artists = artistIds.map((id) => artistMap.get(String(id))).filter(Boolean);
    const title = attrs.title || '';
    const version = attrs.version || '';
    const fullTitle = version ? `${title} (${version})` : title;
    tracks.push({ id: entry.id, title, version, fullTitle, artists });
  }
  return tracks;
}

/**
 * Returns the set of track ids currently in a playlist.
 */
export async function getPlaylistTrackIds(playlistId) {
  const ids = new Set();
  let nextPath = `/playlists/${playlistId}/relationships/items?countryCode=US&locale=en-US`;
  let page = 0;
  while (nextPath && page < 50) {
    const data = await tidalFetch(nextPath);
    for (const item of data?.data || []) {
      if (item.id) ids.add(String(item.id));
    }
    nextPath = data?.links?.next || null;
    page++;
  }
  return ids;
}

/**
 * Adds tracks to a playlist in batches of ≤20.
 */
export async function addTracksToPlaylist(playlistId, trackIds) {
  if (!trackIds.length) return { added: 0, batches: 0 };
  const batches = chunkArray([...new Set(trackIds)], 20);
  let added = 0;
  for (let i = 0; i < batches.length; i++) {
    const items = batches[i].map((id) => ({ id: String(id), type: 'tracks' }));
    await tidalFetch(`/playlists/${playlistId}/relationships/items`, {
      method: 'POST',
      body: { data: items },
    });
    added += items.length;
    printSameLine(`Added batch ${i + 1}/${batches.length} (${items.length} tracks)`);
    if (i < batches.length - 1) await sleep(1000);
  }
  console.log('');
  return { added, batches: batches.length };
}
