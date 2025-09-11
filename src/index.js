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
  deleteFile,
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

      let tracks = [];
      if (data.recenttracks && data.recenttracks.track) {
        if (Array.isArray(data.recenttracks.track)) {
          tracks = data.recenttracks.track;
        } else if (typeof data.recenttracks.track === 'object') {
          tracks = [data.recenttracks.track];
        }
      } else {
        console.error('Unexpected Last.fm response:', data);
        return [];
      }

      // When processing Last.fm tracks:
      const formattedTracks = tracks
        .filter((track) => !(track['@attr'] && track['@attr'].nowplaying === 'true')) // Exclude now playing
        .map((track) => ({
          name: track.name,
          artist: track.artist['#text'],
          album: track.album ? track.album['#text'] : '',
          date: track.date && track.date.uts ? new Date(parseInt(track.date.uts) * 1000).toISOString() : getLocalTimestamp()
        }));

      allFetchedTracks.push(...formattedTracks);

      const totalPages = parseInt(data.recenttracks['@attr'].totalPages, 10) || 1;
      printSameLine(`Fetched page: ${page}/${totalPages}`);

      if (tracks.length < 200 || page >= totalPages) {
        shouldContinueFetching = false;
        console.log('\nFinished fetching Last.fm history.');
      } else {
        page++;
        await sleep(1000);
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

async function refreshTidalAccessToken() {
  const url = 'https://auth.tidal.com/v1/oauth2/token';
  const refreshToken = process.env.TIDAL_REFRESH_TOKEN;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${tidalClientId}:${tidalClientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  updateEnvVariable('TIDAL_ACCESS_TOKEN', data.access_token);
  if (data.refresh_token) {
    updateEnvVariable('TIDAL_REFRESH_TOKEN', data.refresh_token);
  }
  tidalAccessToken = data.access_token;
  tidalHeaders.Authorization = `Bearer ${tidalAccessToken}`;
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
        tidalTokenTries++;
        console.log(`Access token expired or invalid. Refreshing token...`);
        tidalAccessToken = await refreshTidalAccessToken();
        tidalHeaders.Authorization = `Bearer ${tidalAccessToken}`;
        return fetchTidalData(url); // Retry the request with the new access token
        break;

      case 404:
        throw new Error("Playlist not found.\nPlease check if the playlist it's public or if it exists");
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
  const tidalTracksIds = [];

  try {
    // Fetch playlist data
    let playlistData = await fetchTidalData(playlistUrl);
    if (!playlistData) return;

    // Extract track details from the included array
    const tracks = playlistData.data;

    printSameLine(`Page: ${currentPageTidal}`);

    for (const track of tracks) {
      tidalTracksIds.push(track?.id || 0);
    }

    await getTidalTracksWithArtists(tidalTracksIds);

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
async function getTidalTracksWithArtists(tidalTracksIds) {
  if (!tracksIds) return; // No tracks to fetch on empty playlist

  const tracksIds = tidalTracksIds.join(',');
  const tracksUrl = `${tidalURL}/tracks?countryCode=US&filter[id]=${tracksIds}&include=artists`;
  let tracksData = await fetchTidalData(tracksUrl);

  if (!tracksData) return;

  // Map artist IDs to their names
  const artistMap = new Map();
  tracksData.included.forEach((artist) => {
    artistMap.set(artist.id, artist.attributes.name);
  });

  // Extract track names and artist names
  tracksData.data.forEach((track) => {
    const trackName = track.attributes.version
      ? `${track.attributes.title} (${track.attributes.version})`
      : track.attributes.title;

    const artistIds = track.relationships.artists.data.map((artist) => artist.id);
    const artistNames = artistIds.map((id) => artistMap.get(id)).filter((name) => name); // Filter out undefined names

    tidalPlaylistSongs.push({
      id: track.id,
      name: trackName,
      artist: artistNames,
    });
  });
}

async function removeTracksFromTidalPlaylist(trackIds) {
  if (!trackIds.length) return;

  // Fetch playlist items to get itemId for each track
  const playlistItemsUrl = `${tidalURL}/playlists/${tidalPlaylistId}/relationships/items?countryCode=US&locale=en-US`;
  const playlistItemsData = await fetchTidalData(playlistItemsUrl);
  if (!playlistItemsData || !playlistItemsData.data) {
    console.error('Failed to fetch playlist items.');
    return;
  }

  // Map trackId to itemId
  const itemsToDelete = playlistItemsData.data
    .filter((item) => trackIds.includes(item.id)) // item.id is the track ID
    .map((item) => ({
      id: item.id,
      meta: { itemId: item.meta.itemId }, // playlist item ID
      type: 'tracks',
    }));

  if (!itemsToDelete.length) {
    console.log('No matching playlist items found for deletion.');
    return;
  }

  const url = `${tidalURL}/playlists/${tidalPlaylistId}/relationships/items`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      ...tidalHeaders,
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify({ data: itemsToDelete }),
  });

  if (response.ok) {
    console.log(`${itemsToDelete.length} Removed songs:`);
    itemsToDelete.forEach((item) => {
      // Find song details from tidalPlaylistSongs
      const song = tidalPlaylistSongs.find((s) => s.id === item.id);
      if (song) {
        console.log(`${song.name} - ${song.artist}`);
      } else {
        console.log(`Track ID: ${item.id}`);
      }
    });
  } else {
    console.error(`Failed to remove tracks: ${response.status} ${await response.text()}`);
  }
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

  deleteFile('listened.json');
  deleteFile('duplicates.json');

  if (listenedSongs.length > 0) {
    writeFileSync('listened.json', JSON.stringify(listenedSongs, null, 2));
    console.log('\nlistened.json file generated');

    // Find Tidal track IDs for listened songs
    const listenedTrackIds = tidalPlaylistSongs
      .filter((song) => listenedSongs.some((ls) => ls.name === song.name && ls.artist === song.artist))
      .map((song) => song.id) // You need to store 'id' in tidalPlaylistSongs when fetching
      .filter(Boolean);

    await removeTracksFromTidalPlaylist(listenedTrackIds);
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
