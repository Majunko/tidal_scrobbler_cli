import { writeFileSync } from 'fs';

// --- TIDAL ---

const tidalClientId = process.env.TIDAL_CLIENT_ID;
const tidalClientSecret = process.env.TIDAL_CLIENT_SECRET;

let tidalAccessToken = process.env.TIDAL_ACCESS_TOKEN;

const tidalPlaylistId = process.env.TIDAL_PLAYLIST_ID;
const tidalPlaylistUrl = `https://openapi.tidal.com/v2/playlists/${tidalPlaylistId}?countryCode=US&locale=en-US&include=items`;

const tidalHeaders = {
  Accept: 'application/vnd.api+json',
  Authorization: `Bearer ${tidalAccessToken}`,
};

let tidalPlaylistSongs = [];
let currentPageTidal = 1;
let totalPagesTidal = 1;

// --- LAST.FM ---

const LASTFM_USERNAME = process.env.LASTFM_USERNAME;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

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
        printSameLine('Invalid access token. Generating new access token...');
        tidalAccessToken = await generateTidalAccessToken();
        return fetchTidalData(url); // Retry the request with the new access token

      case 429:
        const retryAfter = parseInt(response.headers.get('Retry-After')) || replenishRate; // Use Retry-After or replenish rate
        printSameLine(`Too many requests, waiting ${retryAfter}s and trying again...`);
        await sleep((retryAfter * 2 + 1) * 1000); // Convert to milliseconds
        return fetchTidalData(url); // Retry the request

      default:
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
  } catch (error) {
    console.error(`Error fetching data from ${url}:`, error.message);
    return null;
  }
}

// Main function to fetch playlist data and extract track/artist information
async function getTidalPlaylistTracksWithArtists(playlistUrl) {
  try {
    // Fetch playlist data
    let playlistData = await fetchTidalData(playlistUrl);
    if (!playlistData) return;

    // Extract track details from the included array
    const tracks = playlistData.included;
    const attributes = playlistData.data.attributes;

    if (attributes?.numberOfItems) {
      console.log(`\nFetching Tidal tracks from playlist (${attributes?.numberOfItems})...`);
      console.log(attributes.name);
      totalPagesTidal = parseInt(Math.ceil(attributes.numberOfItems / 20));
    }

    let i = 0;
    console.log(`\nPage: ${currentPageTidal}/${totalPagesTidal}\n`);

    // Process each track
    for (const track of tracks) {
      try {
        const trackName = track.attributes.title;
        const artistLink = track.relationships.artists.links.self;

        // Fetch artist IDs
        const artistResponse = await fetchTidalData(
          `https://openapi.tidal.com/v2${artistLink}&include=artists`
        );
        if (!artistResponse) continue;

        const artistNames = artistResponse.included.map((artist) => artist.attributes.name);

        tidalPlaylistSongs.push({
          name: trackName,
          artist: artistNames,
        });

        i++;

        // Print track and artist information
        printSameLine(`Tidal tracks: ${i}/${tracks.length} | ${trackName} - ${artistNames.join(', ')}`);
        await sleep(1000); // Rate limiting
      } catch (error) {
        console.error(`Error processing track ${track.id}:`, error.message);
      }
    }

    process.stdout.write('\n');

    // Check for next page
    let nextPage = playlistData.data?.relationships?.items?.links?.next || playlistData?.links?.next || null;

    if (nextPage) {
      currentPageTidal++;
      const uri = `https://openapi.tidal.com/v2${nextPage}&include=items`;
      return await getTidalPlaylistTracksWithArtists(uri); // Recursively fetch the next page
    } else {
      console.log('No more pages available.');
    }
  } catch (error) {
    console.error('Error Tidal API:', error.message);
  }
  console.log('');
}

async function getLastfmListeningHistory() {
  let tracks = [];
  let page = 1;
  let totalPages = 1;

  console.log('Fetching last.fm listening history...');

  while (page <= totalPages) {
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${LASTFM_USERNAME}&api_key=${LASTFM_API_KEY}&format=json&limit=200&page=${page}`;

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
  // TIDAL
  await getTidalPlaylistTracksWithArtists(tidalPlaylistUrl);

  // LAST.FM
  let recentTracks = await getLastfmListeningHistory();

  tidalPlaylistSongs = await sortAndJoinArtists(tidalPlaylistSongs);
  recentTracks = await sortAndJoinArtists(recentTracks);

  const result = await compareSongsAlreadyListened(tidalPlaylistSongs, recentTracks);
  writeFileSync('listened.json', JSON.stringify(result, null, 2));
  console.log('listened.json file generated');
})();

//TODO buscar todos los artistas en 1 solo request con GET /artists
// https://openapi.tidal.com/v2/artists?countryCode=US&include=albums&filter%5Bid%5D=1566%2C7404405
