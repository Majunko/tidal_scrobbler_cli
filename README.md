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

## Beatport Top 100 (optional)

The Beatport Top 100 is fetched from Beatport's official API v4 (`api.beatport.com`) instead of
scraping the HTML (which is blocked by Cloudflare). To use it you need a Beatport account:

1. Set your credentials in the `.env` file:
   ```
   BEATPORT_USERNAME='your-beatport-email'
   BEATPORT_PASSWORD='your-beatport-password'
   ```
2. On the first run the script obtains an OAuth token automatically and stores it in the `.env`
   file (`BEATPORT_ACCESS_TOKEN`, `BEATPORT_REFRESH_TOKEN`, `BEATPORT_TOKEN_EXPIRES_AT`). It
   refreshes itself afterwards, so no other secret files are needed.
3. Run `npm run beatport`.
