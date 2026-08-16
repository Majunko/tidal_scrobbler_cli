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
  sortAndJoinArtists,
  getLocalTimestamp,
  deleteFile,
  chunkArray,
} from './utils.js';
import { tidalFetch, getPlaylistItems } from './tidal_api.js';
import {
  findDuplicateTracks,
  compareSongsAlreadyListened,
} from './track_matcher.js';

// --- TIDAL ---
const tidalPlaylistId = process.env.TIDAL_PLAYLIST_ID;
const tidalURL = 'https://openapi.tidal.com/v2';

const lastFmHeaders = {
  'User-Agent': 'LastFMScrobbler/1.0 (https://github.com/Majunko/tidal_scrobbler_cli)',
};

let tidalPlaylistSongs = [];

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
          date:
            track.date && track.date.uts
              ? new Date(parseInt(track.date.uts) * 1000).toISOString()
              : getLocalTimestamp(),
        }));

      allFetchedTracks.push(...formattedTracks);

      const totalPages = parseInt(data.recenttracks['@attr'].totalPages, 10) || 1;
      printSameLine(`Fetched page: ${page}/${totalPages}`);

      if (tracks.length < 200 || page >= totalPages) {
        shouldContinueFetching = false;
        console.log('\nFinished fetching Last.fm history.');
      } else {
        page++;
        await sleep(250); // Last.fm allows 5 requests/second
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
  db.exec('BEGIN');
  try {
    for (const track of reversedTracks) {
      const exists = await checkTrackExists(db, track.artist, track.name);
      if (!exists) {
        await insertTrack(db, track);
        insertedCount++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('Failed to save tracks:', err.message);
    throw err;
  }

  db.close((err) => {
    if (err) {
      console.error('Failed to close the database connection:', err.message);
    }
  });

  console.log(`Total new Last.fm tracks added to the database: ${insertedCount}`);
  return [];
}

// Fetch all playlist items (pagination handled by getPlaylistItems) and build
// tidalPlaylistSongs in chunks to avoid an oversized filter[id] URL.
async function getTidalPlaylistIds() {
  try {
    const items = await getPlaylistItems(tidalPlaylistId);
    const chunks = chunkArray(items, 20); // /tracks filter[id] accepts at most 20 values

    for (let i = 0; i < chunks.length; i++) {
      printSameLine(`Page: ${i + 1}`);
      await getTidalTracksWithArtists(chunks[i]);
    }

    if (chunks.length > 0) console.log('\nNo more pages available.');
    else console.log('\nPlaylist is empty.');
  } catch (error) {
    console.error('Error Tidal API:', error.message);
  }
  console.log('');
}

// Max 20 artists per request
async function getTidalTracksWithArtists(trackIdsAndMetaItemIds) {
  if (!trackIdsAndMetaItemIds.length) return; // No tracks to fetch on empty playlist

  // Request each unique track ID once to avoid redundant requests
  const uniqueTrackIds = [...new Set(trackIdsAndMetaItemIds.map((item) => item.id))];
  const tracksIds = uniqueTrackIds.join(',');
  const tracksUrl = `${tidalURL}/tracks?countryCode=US&filter[id]=${tracksIds}&include=artists`;
  let tracksData;
  try {
    tracksData = await tidalFetch(tracksUrl);
  } catch (error) {
    console.error('Error fetching Tidal tracks:', error.message);
    return;
  }

  if (!tracksData) return;

  // Map artist IDs to their names (if included)
  const artistMap = new Map();
  if (Array.isArray(tracksData.included)) {
    tracksData.included.forEach((artist) => {
      artistMap.set(artist.id, artist.attributes.name);
    });
  }

  // Build a map of track id -> { name, artistNames }
  const trackDetails = new Map();
  (tracksData.data || []).forEach((track) => {
    const trackName = track.attributes.version
      ? `${track.attributes.title} (${track.attributes.version})`
      : track.attributes.title;

    const artistIds = (track.relationships && track.relationships.artists && Array.isArray(track.relationships.artists.data))
      ? track.relationships.artists.data.map((artist) => artist.id)
      : [];

    const artistNames = artistIds.map((id) => artistMap.get(id)).filter((name) => name);

    trackDetails.set(String(track.id), { name: trackName, artistNames });
  });

  // For each playlist item (preserves duplicates), add an entry using its own meta.itemId
  trackIdsAndMetaItemIds.forEach((item) => {
    const details = trackDetails.get(String(item.id));
    if (details) {
      tidalPlaylistSongs.push({
        id: item.id,
        name: details.name,
        artist: details.artistNames,
        itemId: item.meta.itemId || null,
      });
    } else {
      // Fallback: push a minimal representation so we don't lose playlist items
      tidalPlaylistSongs.push({
        id: item.id,
        name: '',
        artist: [],
        itemId: item.meta.itemId || null,
      });
    }
  });
}

async function removeTracksFromTidalPlaylist(trackIds, label = 'track') {
  if (!trackIds.length) return;

  // Split the IDs into batches of ≤20
  const batches = chunkArray(trackIds, 20);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];

    // Build the payload for THIS batch
    let itemsToDelete = tidalPlaylistSongs
      .filter(song => batch.includes(song.id))
      .map(song => ({
        id: song.id,
        meta: { itemId: song.itemId }, // playlist‑item ID
        type: 'tracks',
      }));

     itemsToDelete = [...new Map(itemsToDelete.map(v => [v.id, v])).values()]; // Remove duplicates

    if (!itemsToDelete.length) {
      console.log(`Batch ${batchIndex + 1}: no matching items to delete.`);
      continue;
    }

    const url = `${tidalURL}/playlists/${tidalPlaylistId}/relationships/items`;

    try {
      // tidalFetch handles auth refresh, rate limiting and retries
      await tidalFetch(url, { method: 'DELETE', body: { data: itemsToDelete } });
      console.log(
        `\nBatch ${batchIndex + 1}/${batches.length}: removed ${itemsToDelete.length} ${label}(s).`
      );
      itemsToDelete.forEach(item => {
        const song = tidalPlaylistSongs.find(s => s.id === item.id);
        if (song) {
          console.log(`${song.name} - ${song.artist}`);
        } else {
          console.log(`Track ID: ${item.id}`);
        }
      });
    } catch (error) {
      console.error(`\nBatch ${batchIndex + 1} failed: ${error.message}`);
    }
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
  await getTidalPlaylistIds();

  // Fetch listened songs from the database for comparison
  let allListenedTracksFromDB = await executeSQL(db, `SELECT name, artist FROM tracks`);

  // Sort and join artists, otherwise artists are an array and we need it to be a string
  tidalPlaylistSongs = sortAndJoinArtists(tidalPlaylistSongs);
  allListenedTracksFromDB = sortAndJoinArtists(allListenedTracksFromDB);

  const listenedSongs = compareSongsAlreadyListened(tidalPlaylistSongs, allListenedTracksFromDB);

  deleteFile('duplicates.json');

  let listenedTrackIds = [];

  if (listenedSongs.length > 0) {
    // Find Tidal track IDs for listened songs
    listenedTrackIds = tidalPlaylistSongs
      .filter((song) => listenedSongs.some((ls) => ls.name === song.name && ls.artist === song.artist))
      .map((song) => song.id) // You need to store 'id' in tidalPlaylistSongs when fetching
      .filter(Boolean);
  } else {
    console.log('No songs you already listened to were found in the database.');
  }

  const duplicates = findDuplicateTracks(tidalPlaylistSongs);
  //console.log(duplicates);
  let duplicateTrackIds = [];
  if (duplicates.length > 0) {
    writeFileSync('duplicates.json', JSON.stringify(duplicates, null, 2));
    console.log('duplicates.json file generated');

    const listenedIdSet = new Set(listenedTrackIds);
    duplicateTrackIds = duplicates
      .map((t) => t.id)
      .filter((id) => id && !listenedIdSet.has(id)); // Don't double-remove listened tracks
  }

  if (listenedTrackIds.length > 0) {
    console.log(`\nRemoving ${listenedTrackIds.length} already-listened track(s) from the playlist...`);
    await removeTracksFromTidalPlaylist(listenedTrackIds, 'listened track');
  }

  if (duplicateTrackIds.length > 0) {
    console.log(`\nRemoving ${duplicateTrackIds.length} duplicate track(s) from the playlist...`);
    await removeTracksFromTidalPlaylist(duplicateTrackIds, 'duplicate track');
  }

  console.log(`\nPlaylist cleanup summary: ${listenedTrackIds.length} listened, ${duplicateTrackIds.length} duplicates.`);

  db.close((err) => {
    if (err) {
      console.error('Failed to close the database connection:', err.message);
    }
  });
})();
