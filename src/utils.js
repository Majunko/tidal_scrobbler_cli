import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const getLocalTimestamp = () => {
  const now = new Date();
  // Format the date and time as a string SQLite can handle (e.g., ISO 8601)
  return now.toISOString(); // Or another format like 'YYYY-MM-DD HH:MM:SS.SSS'
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
    'TIDAL_ACCESS_TOKEN',
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
      name: song.name,
      artist: artistString,
      album: song.album,
    };
  });
};

// Return the songs i've never listened to
export const compareSongsAlreadyListened = (tidalTracks, lastfmTracks) => {
  // Create a Set of listened tracks from Last.fm
  const listenedTracks = new Set(
    lastfmTracks.map((track) => `${track.name.toLowerCase()}|${track.artist.toLowerCase()}`)
  );

  // Filter Tidal tracks to keep only those that exist in Last.fm
  return tidalTracks.filter((track) =>
    listenedTracks.has(`${track.name.toLowerCase()}|${track.artist.toLowerCase()}`)
  );
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
