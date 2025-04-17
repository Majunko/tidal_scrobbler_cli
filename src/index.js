import { writeFileSync } from 'fs';
import sqlite3 from 'sqlite3';
import { existsAllTables, executeSQL } from './sql.js';
import {
  sleep,
  printSameLine,
  checkEnvVariables,
  updateEnvVariable,
  findDuplicateTracks,
  sortAndJoinArtists,
  compareSongsAlreadyListened,
} from './utils.js';

// --- TIDAL ---
const tidalClientId = process.env.TIDAL_CLIENT_ID;
const tidalClientSecret = process.env.TIDAL_CLIENT_SECRET;

let tidalAccessToken = process.env.TIDAL_ACCESS_TOKEN;

const tidalPlaylistId = process.env.TIDAL_PLAYLIST_ID;
const tidalURL = 'https://openapi.tidal.com/v2';
const tidalPlaylistUrl = `${tidalURL}/playlists/${tidalPlaylistId}/relationships/items?countryCode=US&locale=en-US`;

const tidalHeaders = {
  Accept: 'application/vnd.api+json',
  Authorization: `Bearer ${tidalAccessToken}`,
};

const lastFmHeaders = {
  'User-Agent': 'LastFMScrobbler/1.0 (https://github.com/Majunko/tidal_scrobbler)',
};

let tidalPlaylistSongs = [];
let currentPageTidal = 1;
let tidalTokenTries = 0;

// --- LAST.FM ---
const lastFmUserName = process.env.LASTFM_USERNAME;
const lastFmApiKey = process.env.LASTFM_API_KEY;

const db = new sqlite3.Database(process.env.LASTFM_DATABASE_NAME);

async function generateTidalAccessToken() {
  const url = 'https://auth.tidal.com/v1/oauth2/token';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${tidalClientId}:${tidalClientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
    }),
  });

  if (response.status != 200) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  tidalTokenTries++;

  const data = await response.json();
  return data.access_token;
}

// Function to fetch data from a URL
async function fetchTidalData(url) {
  try {
    const response = await fetch(url, { headers: tidalHeaders });

    // Parse rate limit headers
    const remainingRequests = parseInt(response.headers.get('x-ratelimit-remaining')) || 0;
    const replenishRate = parseInt(response.headers.get('x-ratelimit-replenish-rate')) || 1; // Default to 1 request per second

    switch (response.status) {
      case 200:
        if (remainingRequests <= 2) {
          // Add a buffer of 2 requests
          //console.log(`Approaching rate limit. Waiting ${replenishRate}s before continuing...`);
          await sleep(replenishRate * 2 * 1000); // Convert to milliseconds
        }
        break;

      case 401:
        tidalAccessToken = null;
        while (tidalTokenTries < 3 && !tidalAccessToken) {
          console.log(`Invalid access token. Generating new access token... Tries: ${tidalTokenTries}`);
          tidalAccessToken = await generateTidalAccessToken();

          if (!tidalAccessToken) {
            console.error('Too many tries to generate a new access tokens. Exiting...');
            process.exit(1);
          }
        }

        tidalHeaders.Authorization = `Bearer ${tidalAccessToken}`; // Important to update the headers with the new access token
        await updateEnvVariable('TIDAL_ACCESS_TOKEN', tidalAccessToken);
        return fetchTidalData(url); // Retry the request with the new access token
        break;

      case 429:
        const retryAfter = parseInt(response.headers.get('Retry-After')) || replenishRate; // Use Retry-After or replenish rate
        printSameLine(`Too many requests, waiting ${retryAfter}s and trying again...`);
        await sleep(retryAfter * 2 * 1000); // Convert to milliseconds
        return fetchTidalData(url); // Retry the request

      default:
        throw new Error(`HTTP error! status: ${response.status}`);
        break;
    }
    return response.json();
  } catch (error) {
    console.error(`Error fetching data from ${url}:`, error.message);
    return null;
  }
}

// Main function to fetch playlist data and extract track id information
async function getTidalPlaylistIds(playlistUrl) {
  const tidalArtistsIds = [];

  try {
    // Fetch playlist data
    let playlistData = await fetchTidalData(playlistUrl);
    if (!playlistData) return;

    // Extract track details from the included array
    const tracks = playlistData.data;

    printSameLine(`Page: ${currentPageTidal}`);

    for (const track of tracks) {
      tidalArtistsIds.push(track?.id || 0);
    }

    await getTidalTracksWithArtists(tidalArtistsIds);

    // Check for next page
    let nextPage = playlistData?.links?.next || null;

    if (nextPage) {
      currentPageTidal++;
      const uri = `${tidalURL}${nextPage}`;
      return await getTidalPlaylistIds(uri); // Recursively fetch the next page
    } else {
      console.log('\nNo more pages available.');
    }
  } catch (error) {
    console.error('Error Tidal API:', error.message);
  }
  console.log('');
}

// Max 20 artists per request
async function getTidalTracksWithArtists(tidalArtistsIds) {
  const artistsIds = tidalArtistsIds.join(',');
  const tracksUrl = `${tidalURL}/tracks?countryCode=US&filter[id]=${artistsIds}&include=artists`;
  let tracksData = await fetchTidalData(tracksUrl);
  if (!tracksData) return;

  // Map artist IDs to their names
  const artistMap = new Map();
  tracksData.included.forEach((artist) => {
    artistMap.set(artist.id, artist.attributes.name);
  });

  // Extract track names and artist names
  tracksData.data.forEach((track) => {
    const trackName = track.attributes.title;
    const artistIds = track.relationships.artists.data.map((artist) => artist.id);
    const artistNames = artistIds.map((id) => artistMap.get(id)).filter((name) => name); // Filter out undefined names

    tidalPlaylistSongs.push({
      name: trackName,
      artist: artistNames,
    });
  });
}

async function getLastfmListeningHistory() {
  let tracks = [];
  let page = 1;
  let totalPages = 1;
  let sql = '';

  console.log('Fetching last.fm listening history...');

  /*
  try {
    
      // const sql = `INSERT INTO tracks(artist, album, name) VALUES (?, ?, ?)`;
      // await executeSQL(db, sql, ['Invidia', 'While 1 < 2', 'Deadmau5']);
      //await executeSQL(db, sql, ['Ira', 'While 1 < 2', 'Deadmau5']);
      
    const sql = `SELECT * from tracks`;
    const res = await executeSQL(db, sql);
    console.log(res);
  } catch (err) {
    console.log(err);
  } finally {
    db.close();
  }
  */

  while (page <= totalPages) {
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastFmUserName}&api_key=${lastFmApiKey}&format=json&limit=200&page=${page}`;

    try {
      const response = await fetch(url, { headers: lastFmHeaders });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();

      // Remove now playing track from every page except the first
      if (page > 2 && data.recenttracks.track[0]?.['@attr']?.nowplaying) {
        data.recenttracks.track.shift();
      }

      tracks.push(
        ...data.recenttracks.track.map((track) => ({
          artist: track.artist['#text'].split(', '),
          album: track.album['#text'] || 'caca',
          name: track.name
        }))
      );

      totalPages = parseInt(data.recenttracks['@attr'].totalPages, 10);
      printSameLine(`Page ${page}/${totalPages}`);
      page++;


      //TODO BORRAR
      page = 99;




    } catch (error) {
      console.error(`\nError fetching data from ${url}:`, error.message);
    }
  }

  process.stdout.write('\n');
  console.log(`Scrobbles: ${tracks.length}`);
  return tracks;
}

(async () => {
  checkEnvVariables();
  await existsAllTables(db);

  // TIDAL
  console.log(`Fetching Tidal playlist IDs...\n`);
  await getTidalPlaylistIds(tidalPlaylistUrl);

  // LAST.FM
  let historyTracks = await getLastfmListeningHistory();

  tidalPlaylistSongs = sortAndJoinArtists(tidalPlaylistSongs);
  historyTracks = sortAndJoinArtists(historyTracks);
  const tidalDuplicates = findDuplicateTracks(tidalPlaylistSongs);

  console.log(historyTracks);

  const listenedSongs = compareSongsAlreadyListened(tidalPlaylistSongs, historyTracks);

  writeFileSync('listened.json', JSON.stringify(listenedSongs, null, 2));
  writeFileSync('lastfm.json', JSON.stringify(historyTracks, null, 2));
  writeFileSync('duplicates.json', JSON.stringify(tidalDuplicates, null, 2));

  console.log('\nlistened.json file generated');
  console.log('lastfm.json file generated');
  console.log('duplicates.json file generated');
})();
