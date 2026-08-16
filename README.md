# Tidal Track Listener Checker

This project checks if a track has already been listened to on Tidal by leveraging the Last.fm API and the Tidal API. It is built using Node.js.

## Prerequisites

To use this project, you need to:

1. **Create a Playlist (public or private) on Tidal**:
   - Copy the **Playlist ID** and paste it into the `.env` file.

2. **Create a Last.fm Application**:
   - Create a new application on Last.fm -> https://www.last.fm/api/account/create
   - Copy the **API Key** and paste it into the `.env` file.

3. **Create a Tidal Application**:
   - Create a new application on Tidal -> https://developer.tidal.com/dashboard
   - Write the Redirect URL to: http://localhost:3000/callback
   - Select the next scopes: `playlists.read`, `playlists.write`
   - Copy the **Client ID** and **Client Secret** and paste them into the `.env` file.

## Setup

1. Clone this repository:
   ```bash
   git clone https://github.com/Majunko/tidal_scrobbler_cli.git
   cd tidal_scrobbler
   ```

2. Set the environment variables in the `.env` file:
   ```bash
   cp .env.example .env
   ```

3. Install the dependencies and start the project:
   ```bash
   # Install dependencies
   npm install

   # Authorize your account to the application to access your playlists
   npm run tidal-oauth

   # Start the process
   npm start
   ```

## Beatport Top 100 (optional)

The genre's top 100 tracks are fetched from Beatport's official API v4 (`api.beatport.com`) instead
of scraping the HTML (which is blocked by Cloudflare). To use it you need a Beatport account:

1. Set your credentials in the `.env` file:
   ```
   BEATPORT_USERNAME='your-beatport-email'
   BEATPORT_PASSWORD='your-beatport-password'
   ```
2. On the first run the script obtains an OAuth token automatically and stores it in the `.env`
   file (`BEATPORT_ACCESS_TOKEN`, `BEATPORT_REFRESH_TOKEN`, `BEATPORT_TOKEN_EXPIRES_AT`). It
   refreshes itself afterwards, so no other secret files are needed.
3. Run `npm run beatport`.

The URLs to scrape are defined in `beatport_urls.txt`, one top-100 URL per line (blank lines and
lines starting with `#` are ignored). By default it contains the top-100 list of
`Techno (Raw / Deep / Hypnotic)` (genre `92`); add or replace URLs to scrape other genres. If the
file is missing or empty, the default genre `92` URL is used. The resulting tracks are saved to
`beatport_scraped.txt` and checked against your listening database, writing the ones you haven't
listened to yet to `beatport_pending.txt`.

## Migrate Beatport tracks to a Tidal playlist (optional)

`npm run tidal-migrate` reads `beatport_pending.txt` and, for every track, searches Tidal and tries to
find the matching track. If exactly one track matches (same title and same artists) it is added to the
Tidal playlist defined by `TIDAL_PLAYLIST_ID`. Tracks that could not be found are written to
`tidal_not_found.txt`; ambiguous matches (multiple candidates, or a same-title track by a different
artist) are written to `tidal_needs_review.txt` with their Tidal track IDs so you can decide manually.
After a successful run, `beatport_pending.txt` and `beatport_scraped.txt` are deleted (the
classification remains in the `tidal_*.txt` files). While it runs, the script shows a live
progress counter (`Processing N/M tracks...`) so you know how many tracks have been processed.

To preview the results without touching the playlist or the pending file, run:

```bash
npm run tidal-migrate:dry
```
