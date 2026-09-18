import { existsSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
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

/**
 * Tries to open a URL in the system browser. Never throws — failures are
 * silently ignored (users can always paste the URL manually).
 */
const trySpawn = (cmd, args) => {
  let child;
  try {
    child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  } catch {
    return;
  }
  // A missing binary (e.g. xdg-open not installed) surfaces as an async
  // 'error' event, not a sync throw — swallow it so the caller never crashes.
  child.on('error', () => {});
  child.unref();
}

export const openBrowser = (url) => {
  if (process.platform === 'darwin') {
    trySpawn('open', [url]);
  } else if (process.platform === 'win32') {
    trySpawn('cmd', ['/c', 'start', '', url]);
  } else {
    trySpawn('xdg-open', [url]);
  }
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