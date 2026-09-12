import { DatabaseSync } from 'node:sqlite';
import { removeDiacritics } from './track_matcher.js';

// Canonical key used for storage and duplicate detection: diacritics/invisible
// chars stripped, NFKC-normalized, whitespace collapsed, lowercased.
const normalize = (value) =>
  removeDiacritics(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

// Title key used for dedup: on top of `normalize`, unifies version-marker
// formatting so "(Radio Edit)" == "[radio edit]" == "Radio Edit" and
// "X (Remix)" == "X Remix". Remaining parentheses/brackets are dropped but
// their content kept, so "(Original Mix)" vs "(Extended Mix)" stay distinct.
const VERSION_MARKERS_TO_STRIP = /\s*[\[\(]\s*(radio edit|single edit|album version|radio mix)\s*[\]\)]\s*/gi;
const titleNormalize = (value) =>
  normalize(value)
    .replace(VERSION_MARKERS_TO_STRIP, ' ')
    .replace(/[\[\](){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const lastFmDatabaseName = process.env.LASTFM_DATABASE_NAME;

// Function to connect to the SQLite database
export const connectDB = async () => {
  try {
    const db = new DatabaseSync(lastFmDatabaseName);
    return db;
  } catch (err) {
    console.error('Failed to connect to the database:', err.message);
    throw err;
  }
}

const createTracksTable = async (db) => {
  const sql = `CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist TEXT NOT NULL,
    album TEXT NOT NULL,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    artist_normalized TEXT,
    name_normalized TEXT
  )`;
  return await executeSQL(db, sql);
}

const columnExists = (db, table, column) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  return columns.some((c) => c.name === column);
}

// Backfills artist_normalized/name_normalized for rows that lack them, and
// consolidates existing duplicates: keep the earliest row per normalized pair.
export const migrateTracksTable = async (db) => {
  const tableName = 'tracks';

  if (!columnExists(db, tableName, 'artist_normalized')) {
    await executeSQL(db, `ALTER TABLE tracks ADD COLUMN artist_normalized TEXT`);
  }
  if (!columnExists(db, tableName, 'name_normalized')) {
    await executeSQL(db, `ALTER TABLE tracks ADD COLUMN name_normalized TEXT`);
  }

  // Backfill rows whose normalized values are not computed yet.
  const rows = db
    .prepare(`SELECT id, artist, name FROM tracks WHERE artist_normalized IS NULL OR name_normalized IS NULL`)
    .all();
  if (rows.length) {
    db.exec('BEGIN');
    try {
      const update = db.prepare(`UPDATE tracks SET artist_normalized = ?, name_normalized = ? WHERE id = ?`);
      for (const row of rows) {
        update.run(normalize(row.artist), titleNormalize(row.name), row.id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // Consolidate existing duplicates: same normalized track inserted with
  // different char variants (e.g. "Uvall" vs "Uväll"). Keep the oldest (MIN id).
  db.exec(`
    DELETE FROM tracks
    WHERE artist_normalized IS NOT NULL
      AND name_normalized IS NOT NULL
      AND id NOT IN (
        SELECT MIN(id)
        FROM tracks
        WHERE artist_normalized IS NOT NULL AND name_normalized IS NOT NULL
        GROUP BY artist_normalized, name_normalized
      )
  `);

  await executeSQL(db, `CREATE INDEX IF NOT EXISTS idx_tracks_normalized ON tracks (artist_normalized, name_normalized)`);
}

export const existsAllTables = async (db) => {
  const tableName = 'tracks';
  const sql = `SELECT name FROM sqlite_master WHERE type='table' AND name=?`;
  const tables = await executeSQL(db, sql, [tableName]);
  if (!tables || tables.length < 1) {
    await createTracksTable(db);
  }
  await migrateTracksTable(db);
}

// Function to insert a new track into the database
export const insertTrack = async (db, track) => {
  try {
    const stmt = db.prepare(
      'INSERT INTO tracks (name, artist, album, date, name_normalized, artist_normalized) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const result = stmt.run(
      track.name,
      track.artist,
      track.album ?? '', // Use empty string if album is undefined
      track.date ?? new Date().toISOString(), // Use current date if missing
      titleNormalize(track.name),
      normalize(track.artist)
    );
    return result.lastID;
  } catch (err) {
    console.error('SQLite insert error:', err.message);
    throw err;
  }
};

export const getLatestTrack = async (db) => {
  try {
    const stmt = db.prepare(`
      SELECT artist, album, name, date
      FROM tracks
      ORDER BY date DESC
      LIMIT 1
    `);
    return stmt.get();
  } catch (err) {
    console.error('Failed to get latest track:', err.message);
    throw err;
  }
}

export const checkTrackExists = async (db, artist, name) => {
  try {
    const stmt = db.prepare(`
      SELECT id
      FROM tracks
      WHERE artist_normalized = ? AND name_normalized = ? LIMIT 1
    `);
    const row = stmt.get(normalize(artist), titleNormalize(name));
    return !!row;
  } catch (err) {
    console.error('Error checking if track exists:', err.message);
    throw err;
  }
}

export const executeSQL = async (db, sql, params = []) => {
  if (!db) {
    throw new Error('db parameter is required');
  }

  try {
    const statement = db.prepare(sql);
    const rows = statement.all(...params);
    // For SELECT queries, resolve with the rows
    if (sql.toLowerCase().startsWith('select')) {
      return rows;
    } else {
      // For INSERT, UPDATE, DELETE, etc., resolve without data (or with affected rows if needed)
      return;
    }
  } catch (err) {
    throw err;
  }
};