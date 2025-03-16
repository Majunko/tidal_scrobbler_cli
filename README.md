# Tidal Track Listener Checker

This project checks if a track has already been listened to on Tidal by leveraging the Last.fm API and the Tidal API. It is built using Node.js.

## Prerequisites

To use this project, you need to:

1. **Create a Public Playlist on Tidal**:
   - Create a public playlist on Tidal and add the tracks you want to check.
   - Copy the **Playlist ID** and paste it into the `.env` file.

2. **Create a Last.fm Application**:
   - Create a new application on Last.fm.
   - Copy the **API Key** and paste it into the `.env` file.

3. **Create a Tidal Application**:
   - Create a new application on Tidal.
   - Copy the **Client ID** and **Client Secret** and paste them into the `.env` file.

## Setup

1. Clone this repository:
   ```bash
   git clone https://github.com/Majunko/tidal_scrobbler.git
   cd tidal_scrobbler
   npm install
   npm start
   ```

2. Set the environment variables in the `.env` file:
   ```bash
   cp .env.example .env
   ```

3. Install the dependencies and start the project:
   ```bash
   npm install
   npm start
   ```