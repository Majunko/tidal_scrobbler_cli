import { writeFileSync, readFileSync } from 'fs';

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
let tidalPlaylistSongs = [];
let currentPageTidal = 1;
let tidalTokenTries = 0;

// --- LAST.FM ---
const lastFmUserName = process.env.LASTFM_USERNAME;
const lastFmApiKey = process.env.LASTFM_API_KEY;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkEnvVariables() {
  const requiredEnvVariables = [
    'TIDAL_CLIENT_ID',
    'TIDAL_CLIENT_SECRET',
    'TIDAL_ACCESS_TOKEN',
    'TIDAL_PLAYLIST_ID',
    'LASTFM_USERNAME',
    'LASTFM_API_KEY'
  ];

  const missingVariables = requiredEnvVariables.filter(variable => !process.env[variable]);

  if (missingVariables.length > 0) {
    console.error(`Missing environment variables: ${missingVariables.join(', ')}`);
    process.exit(1);
  }
}

async function updateEnvVariable(key, newValue) {
  const envFilePath = '.env';
  let envFileContent = readFileSync(envFilePath, 'utf8');

  // Use a regular expression to find and replace the key-value pair
  const regex = new RegExp(`^${key}=.*`, 'm');
  if (regex.test(envFileContent)) {
      envFileContent = envFileContent.replace(regex, `${key}='${newValue}'`);
      console.log(`Updated ${key}\n`);
  } else {
      throw new Error(`Key ${key} not found in .env file.`);
  }

  // Write the updated content back to the .env file
  writeFileSync(envFilePath, envFileContent);
}

function printSameLine(text) {
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(text);
}

async function sortAndJoinArtists(tracks) {
  const a = tracks.map((song) => {
    return {
      name: song.name,
      artist:
        song.artist.length > 0
          ? song.artist
              .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })) // Case-insensitive sort
              .join(', ')
          : 'Unknown Artist', // Handle empty artist array
    };
  });

  return a;
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
        await updateEnvVariable('TIDAL_ACCESS_TOKEN', tidalAccessToken);
        return fetchTidalData(url); // Retry the request with the new access token
        break;

      case 429:
        const retryAfter = parseInt(response.headers.get('Retry-After')) || replenishRate; // Use Retry-After or replenish rate
        printSameLine(`Too many requests, waiting ${retryAfter}s and trying again...`);
        await sleep((retryAfter * 2) * 1000); // Convert to milliseconds
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

    console.log(`Page: ${currentPageTidal}`);

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
      console.log('No more pages available.');
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

  console.log('Fetching last.fm listening history...');

  while (page <= totalPages) {
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastFmUserName}&api_key=${lastFmApiKey}&format=json&limit=200&page=${page}`;

    try {
      const response = await fetch(url);
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
          name: track.name,
          artist: track.artist['#text'].split(', '),
        }))
      );

      totalPages = parseInt(data.recenttracks['@attr'].totalPages, 10);
      printSameLine(`Page ${page}/${totalPages}`);
      page++;
    } catch (error) {
      console.error(`\nError fetching data from ${url}:`, error.message);
    }
  }

  process.stdout.write('\n');
  console.log(`Scrobbles: ${tracks.length}`);
  return tracks;
}

// Return the songs i've never listened to
async function compareSongsAlreadyListened(tidalTracks, lastfmTracks) {
  // Create a Set of listened tracks from Last.fm
  const listenedTracks = new Set(
    lastfmTracks.map((track) => `${track.name.toLowerCase()}|${track.artist.toLowerCase()}`)
  );

  // Filter Tidal tracks to keep only those that exist in Last.fm
  return tidalTracks.filter((track) =>
    listenedTracks.has(`${track.name.toLowerCase()}|${track.artist.toLowerCase()}`)
  );
}

(async () => {
  await checkEnvVariables();
  // TIDAL
  console.log(`Fetching Tidal playlist IDs...\n`);
  await getTidalPlaylistIds(tidalPlaylistUrl);

  // LAST.FM
  let recentTracks = await getLastfmListeningHistory();

  tidalPlaylistSongs = await sortAndJoinArtists(tidalPlaylistSongs);
  recentTracks = await sortAndJoinArtists(recentTracks);

  const result = await compareSongsAlreadyListened(tidalPlaylistSongs, recentTracks);
  writeFileSync('listened.json', JSON.stringify(result, null, 2));
  console.log('\nlistened.json file generated');
})();
