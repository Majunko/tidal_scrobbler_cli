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
   npm run oauth

   # Start the process
   npm start
   ```

## Beatport New Releases (optional)

The newest tracks from the Beatport releases tab are fetched from Beatport's official API v4
(`api.beatport.com`) instead of scraping the HTML (which is blocked by Cloudflare). To use it you
need a Beatport account:

1. Set your credentials in the `.env` file:
   ```
   BEATPORT_USERNAME='your-beatport-email'
   BEATPORT_PASSWORD='your-beatport-password'
   ```
2. On the first run the script obtains an OAuth token automatically and stores it in the `.env`
   file (`BEATPORT_ACCESS_TOKEN`, `BEATPORT_REFRESH_TOKEN`, `BEATPORT_TOKEN_EXPIRES_AT`). It
   refreshes itself afterwards, so no other secret files are needed.
3. Run `npm run beatport`.

The script reads the URL(s) defined in `src/beatport.js`. By default it uses the releases tab of
`Techno (Raw / Deep / Hypnotic)` (genre `92`) ordered by publish date (newest first). The sub-genre
filter is defined in the `.env` file via `BEATPORT_SUB_GENRE_IDS` (a comma-separated list of sub-genre
ids, e.g. `224,225` for `Deep / Hypnotic` and `Raw`); leave it empty to include every sub-genre of
the genre. The `per_page` query parameter in the URL is picked up automatically. The resulting tracks
are saved to `beatport_tracks.txt` and checked against your listening database, writing the ones you
haven't listened to yet to `beatport_not_found.txt`.
