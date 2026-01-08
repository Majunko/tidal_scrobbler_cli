# Copilot / AI Agent Instructions — Tidal Scrobbler CLI

Purpose: give an AI agent the minimal, high-value knowledge needed to be productive in this repo.

## Big picture
- This is a small Node.js CLI that compares a Tidal playlist to your Last.fm listening history and removes tracks from a playlist that you already listened to.
- Main flow:
  1. Fetch Last.fm recent tracks and persist them to a local SQLite DB (`src/sql.js`).
  2. Fetch a Tidal playlist and its tracks (including artist info).
  3. Compare Tidal tracks to DB using fuzzy title & normalized artist matching (`src/utils.js`).
  4. Generate `listened.json` and `duplicates.json` and remove identified tracks from the Tidal playlist (batched deletes).

## Entry points & scripts
- `npm start` → runs `node --env-file=.env src/index.js` (main process).
- `npm run oauth` → runs `node --env-file=.env src/tidal_oauth.js` to perform OAuth (starts local HTTP server at `http://localhost:3000/callback`).

## Required environment variables (from `.env.example`)
- TIDAL_CLIENT_ID, TIDAL_CLIENT_SECRET
- TIDAL_ACCESS_TOKEN, TIDAL_REFRESH_TOKEN (populated by OAuth or refreshed at runtime)
- TIDAL_PLAYLIST_ID (playlist to check/clean)
- LASTFM_USERNAME, LASTFM_API_KEY
- LASTFM_DATABASE_NAME (SQLite file path, e.g. `lastfm.db`)

Note: `src/utils.js:updateEnvVariable` expects the key to already exist in `.env` and will replace the line with `KEY='value'` (single quotes).

## Key implementation details & patterns to follow
- Module format: ES modules (`package.json` has `type: "module"`).
- DB: uses `sqlite3`. `src/sql.js` will create the `tracks` table if it doesn't exist (`existsAllTables`). Table columns: `id, artist, album, name, date`.
- Last.fm fetch: paginated (limit 200), excludes `nowplaying` items, and reverses fetched results to insert oldest→newest.
- Fuzzy matching: title fuzzy match uses Fuse.js with a very strict threshold (0.05). Artist comparison uses `normalizeArtist()` (lowercased, diacritics removed, sorted).
- Playlist removal:
  - Fetch tracks and associated `meta.itemId` (playlist item id) via Tidal API.
  - Delete in batches ≤ 20 (`chunkArray`) and pass objects with `{ id, meta: { itemId }, type: 'tracks' }` to the DELETE endpoint.
- Duplicate detection:
  - Uses normalized artist matching plus a strict fuzzy title comparison (same algorithm as `compareSongsAlreadyListened`) so minor title differences don't prevent detection.
  - Only subsequent occurrences are returned as "duplicates", ensuring the first (original) track remains if the user has never listened to the song.
- Rate limiting and token refresh:
  - `fetchTidalData()` checks `x-ratelimit-remaining`/`x-ratelimit-replenish-rate` and waits accordingly.
  - On 401, the code automatically calls `refreshTidalAccessToken()` and retries. The refresh updates `.env` via `updateEnvVariable()`.
  - On 429, the code reads `Retry-After` header and retries after a wait.

## Files created/updated at runtime
- `.env` — read/updated (`updateEnvVariable`) by OAuth/token refresh paths.
- DB file — defined by `LASTFM_DATABASE_NAME`.
- `listened.json` — saved when matches are found.
- `duplicates.json` — saved when duplicates found.

## Debugging & workflows
- No test suite is present. Manual run steps:
  1. `cp .env.example .env` and fill values.
  2. `npm install`.
  3. `npm run oauth` and follow the printed auth URL (server listens on port 3000 for callback).
  4. `npm start` to run the main process (watch console logs and generated JSON files).
- Helpful debug hooks: `printSameLine()` shows progress; many functions log errors to `console.error`.

## Style & contribution notes for AI patches
- Preserve helper functions in `src/utils.js` and use them when possible (e.g., normalization, chunking, env updates).
- When changing `.env` handling be mindful that `updateEnvVariable()` expects and replaces an existing key; if adding keys, update `.env.example` too.
- Keep Tidal deletion batches ≤ 20 and respect rate-limit headers.
- Use examples from real code paths when suggesting fixes (e.g., modifying `fetchTidalData()` retry logic, or improving `isFuzzyTitleMatch` thresholds).

---
If anything here looks incomplete or you want a more detailed section (e.g., a short code snippet showing the payload for playlist deletion), tell me which part and I will iterate. Thanks!