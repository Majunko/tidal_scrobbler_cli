import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import crypto from 'crypto';
import Fuse from 'fuse.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const getLocalTimestamp = () => {
  const now = new Date();
  // Format the date and time as a string SQLite can handle (e.g., ISO 8601)
  return now.toISOString(); // Or another format like 'YYYY-MM-DD HH:MM:SS.SSS'
}

export const base64URLEncode = (str) => {
  return str.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export const randomBytes32 = () => {
 return crypto.randomBytes(32);
}

export const sha256 = (buffer) => {
  return crypto.createHash('sha256').update(buffer).digest();
}

export const deleteFile = (path) => {
  if (existsSync(path)) {
    unlinkSync(path);
    return true;
  }
  return false;
}

export const printSameLine = (text) => {
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(text);
}

export const checkEnvVariables = () => {
  const requiredEnvVariables = [
    'TIDAL_CLIENT_ID',
    'TIDAL_CLIENT_SECRET',
    'TIDAL_PLAYLIST_ID',
    'LASTFM_USERNAME',
    'LASTFM_API_KEY',
    'LASTFM_DATABASE_NAME'
  ];

  const missingVariables = requiredEnvVariables.filter(variable => !process.env[variable]);

  if (missingVariables.length > 0) {
    console.error(`Missing environment variables: ${missingVariables.join(', ')}`);
    process.exit(1);
  }
}

export const updateEnvVariable = (key, newValue) => {
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

/**
 * Returns an array of slices, each at most `size` elements long.
 * Example: chunkArray([1,2,3,4,5], 2) → [[1,2],[3,4],[5]]
 */
export const chunkArray = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export const sortAndJoinArtists = (tracks) => {
  return tracks.map((song) => {
    let artistString = typeof song.artist === 'string' ? song.artist.split(',') : song.artist;

    if (Array.isArray(artistString)) {
      artistString = artistString
        .map(artist => artist.trim())
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        .join(', ');
    } else {
      artistString = 'Unknown Artist'; // Handle cases where artist is neither array nor string
    }

    return {
      id: song.id,
      name: song.name,
      artist: artistString,
      itemId: song.itemId
    };
  });
};

// Normalize artist string: split by comma/ampersand, trim, sort, join
export const normalizeArtist = (artist) => {
  if (!artist) return '';
  // Replace ' & ' and ',' with a common separator, then split
  return artist
    .replace(/(\s*&\s*|,\s*)/g, ',') // unify separators: "A & B, C" → "A,B,C"
    .split(',')
    .map(a => a.trim().toLowerCase())
    .sort()
    .join(',');
}

// Return the songs i've never listened to
export const compareSongsAlreadyListened = (tidalSongs, dbSongs) => {
  return tidalSongs.filter(tidalSong =>
    dbSongs.some(dbSong =>
      isFuzzyTitleMatch(dbSong.name, tidalSong.name) &&
      normalizeArtist(dbSong.artist) === normalizeArtist(tidalSong.artist)
    )
  );
}

export const isFuzzyTitleMatch = (titleA, titleB) => {
  const fuse = new Fuse([titleA], {
    includeScore: true,
    threshold: 0.3, // 70% similarity threshold
  });
  const result = fuse.search(titleB);
  return result.length > 0;
}

/**
 * Returns only the duplicate tracks
 */
export const findDuplicateTracks = (tracks) => {
  const seen = new Map(); // Stores composite keys we've encountered
  const duplicates = []; // Stores the actual duplicate objects

  for (const track of tracks) {
    // Create a unique key combining name and artist
    const key = `${track.name.toLowerCase()}|${track.artist.toLowerCase()}`;

    if (seen.has(key)) {
      duplicates.push(track); // Found a duplicate
    } else {
      seen.set(key, true); // Mark this combination as seen
    }
  }

  return duplicates;
}
