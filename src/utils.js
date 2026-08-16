import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import crypto from 'crypto';

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
  if (typeof process.stdout.clearLine === 'function' && typeof process.stdout.cursorTo === 'function') {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
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
 * Parses a "Name - Artist" line (e.g. from beatport_pending.txt).
 * Cuts at the LAST " - " so names containing " - " stay intact.
 */
export const parseBeatportLine = (line) => {
  const trimmed = String(line).trim();
  if (!trimmed) return null;

  const splitIndex = trimmed.lastIndexOf(' - ');
  if (splitIndex === -1) return null;

  const name = trimmed.slice(0, splitIndex).trim();
  const artist = trimmed.slice(splitIndex + 3).trim();

  if (!name || !artist) return null;
  return { name, artist, line: trimmed };
};

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
