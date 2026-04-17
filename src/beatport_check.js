import { readFileSync, writeFileSync } from 'fs';
import { connectDB, executeSQL, existsAllTables } from './sql.js';
import { compareSongsAlreadyListened } from './utils.js';

const inputPath = 'beatport_tracks.txt';
const outputPath = 'beatport_not_found.txt';

const parseBeatportLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const splitIndex = trimmed.lastIndexOf(' - ');
  if (splitIndex === -1) return null;

  const name = trimmed.slice(0, splitIndex).trim();
  const artist = trimmed.slice(splitIndex + 3).trim();

  if (!name || !artist) return null;
  return { name, artist };
};

const trackKey = (track) => `${track.name}|||${track.artist}`;

async function runBeatportCheck() {
  let db;
  try {
    const raw = readFileSync(inputPath, 'utf8');
    const beatportTracks = raw
      .split('\n')
      .map(parseBeatportLine)
      .filter(Boolean);

    if (beatportTracks.length === 0) {
      console.log('No valid tracks found in beatport_tracks.txt');
      return;
    }

    db = await connectDB();
    await existsAllTables(db);

    const dbTracks = await executeSQL(db, 'SELECT name, artist FROM tracks');

    const foundTracks = compareSongsAlreadyListened(beatportTracks, dbTracks);
    const foundKeys = new Set(foundTracks.map(trackKey));

    const notFoundTracks = beatportTracks.filter((t) => !foundKeys.has(trackKey(t)));

    const output = notFoundTracks.map((t) => `${t.name} - ${t.artist}`).join('\n');
    writeFileSync(outputPath, output);

    console.log('--- Beatport Track Check ---');
    console.log(`Input tracks:   ${beatportTracks.length}`);
    console.log(`Found in DB:    ${foundTracks.length}`);
    console.log(`Not found:      ${notFoundTracks.length}`);
    console.log(`Output written: ${outputPath}`);
  } catch (err) {
    console.error('Failed to check Beatport tracks:', err.message);
  } finally {
    if (db) db.close();
  }
}

runBeatportCheck();
