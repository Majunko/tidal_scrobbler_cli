import { writeFileSync } from 'fs';
import {
  existsAllTables,
  executeSQL,
  insertTrack,
  connectDB,
  getLatestTrack,
  checkTrackExists,
} from './sql.js';
import {
  sleep,
  printSameLine,
  checkEnvVariables,
  updateEnvVariable,
  findDuplicateTracks,
  sortAndJoinArtists,
  compareSongsAlreadyListened,
  getLocalTimestamp,
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
  'User-Agent': 'LastFMScrobbler/1.0 (https://github.com/Majunko/tidal_scrobbler_cli)',
};

let tidalPlaylistSongs = [];
let currentPageTidal = 1;
let tidalTokenTries = 0;

// --- LAST.FM ---
const lastFmUserName = process.env.LASTFM_USERNAME;
const lastFmApiKey = process.env.LASTFM_API_KEY;

async function getLastfmListeningHistory() {
  const db = await connectDB();
  let allFetchedTracks = [];
  let page = 1;
  let shouldContinueFetching = true;
  let fromTimestamp = 0; // Default to 0 if the database is empty

  // Get the timestamp of the latest track in the database
  const latestTrack = await getLatestTrack(db);
  if (latestTrack && latestTrack.date) {
    fromTimestamp = Math.floor(new Date(latestTrack.date).getTime() / 1000); // Convert ISO date to Unix timestamp (seconds)
    console.log(`Fetching new tracks since: ${latestTrack.date} (Unix timestamp: ${fromTimestamp})`);
  } else {
    console.log('Database is empty. Fetching all history.');
  }

  console.log('Fetching last.fm listening history from API...');

  while (shouldContinueFetching) {
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastFmUserName}&api_key=${lastFmApiKey}&format=json&limit=200&page=${page}${
      fromTimestamp > 0 ? `&from=${fromTimestamp}` : ''
    }`;

    try {
      const response = await fetch(url, { headers: lastFmHeaders });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();

      if (data && data.recenttracks && data.recenttracks.track) {
        const tracks = data.recenttracks.track.map((item) => ({
          artist: item.artist['#text'],
          album: item.album['#text'],
          name: item.name,
          date:
            item.date && item.date.uts
              ? new Date(parseInt(item.date.uts) * 1000).toISOString()
              : getLocalTimestamp(),
        }));
        allFetchedTracks.push(...tracks);

        const totalPages = parseInt(data.recenttracks['@attr'].totalPages, 10);
        printSameLine(`Fetched page: ${page}/${totalPages}`);

        if (tracks.length < 200 || page >= totalPages) {
          shouldContinueFetching = false;
          console.log('\nFinished fetching Last.fm history.');
        } else {
          page++;
          await sleep(1000);
        }
      } else {
        console.warn('\nNo tracks found on this page or API error.');
        shouldContinueFetching = false;
      }
    } catch (error) {
      console.error(`\nError fetching data from ${url}:`, error.message);
      shouldContinueFetching = false;
    }
  }

  // Reverse the fetched tracks to save from oldest to newest
  const reversedTracks = [...allFetchedTracks].reverse();
  let insertedCount = 0;

  console.log('Saving Last.fm history to database (oldest to newest)...');
  for (const track of reversedTracks) {
    const exists = await checkTrackExists(db, track.artist, track.name);
    if (!exists) {
      await insertTrack(db, track);
      insertedCount++;
    }
  }

  db.close((err) => {
    if (err) {
      console.error('Failed to close the database connection:', err.message);
    } else {
      console.log('\nDatabase connection closed after saving Last.fm history.');
    }
  });

  console.log(`Total new Last.fm tracks added to the database: ${insertedCount}`);
  return [];
}

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
        updateEnvVariable('TIDAL_ACCESS_TOKEN', tidalAccessToken);
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

(async () => {
  checkEnvVariables();
  const db = await connectDB();
  await existsAllTables(db);

  // Fetch and save Last.fm history, oldest to newest
  await getLastfmListeningHistory();

  // TIDAL
  console.log(`\nFetching Tidal playlist IDs...\n`);
  await getTidalPlaylistIds(tidalPlaylistUrl);

  // Fetch listened songs from the database for comparison
  let allListenedTracksFromDB = await executeSQL(db, `SELECT name, artist FROM tracks`);

  // Sort and join artists, otherwise artists are an array and we need it to be a string
  tidalPlaylistSongs = sortAndJoinArtists(tidalPlaylistSongs);
  allListenedTracksFromDB = sortAndJoinArtists(allListenedTracksFromDB);

  const listenedSongs = compareSongsAlreadyListened(tidalPlaylistSongs, allListenedTracksFromDB);

  if (listenedSongs.length > 0) {
    writeFileSync('listened.json', JSON.stringify(listenedSongs, null, 2));
    console.log('\nlistened.json file generated');
  } else {
    console.log('No songs you already listened to were found in the database.');
  }

  const duplicates = findDuplicateTracks(tidalPlaylistSongs);

  if (duplicates.length > 0) {
    writeFileSync('duplicates.json', JSON.stringify(duplicates, null, 2));
    console.log('duplicates.json file generated');
  }

  db.close((err) => {
    if (err) {
      console.error('Failed to close the database connection:', err.message);
    } else {
      console.log('Database connection closed.');
    }
  });
})();
