import { DatabaseSync } from 'node:sqlite';

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
    date TEXT NOT NULL
  )`;
  return await executeSQL(db, sql);
}

export const existsAllTables = async (db) => {
  const tableName = 'tracks';
  const sql = `SELECT name FROM sqlite_master WHERE type='table' AND name=?`;
  const tables = await executeSQL(db, sql, [tableName]);
  if (!tables || tables.length < 1) {
    await createTracksTable(db);
  }
}

// Function to insert a new track into the database
export const insertTrack = async (db, track) => {
  try {
    const stmt = db.prepare(
      'INSERT INTO tracks (name, artist, album, date) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(
      track.name,
      track.artist,
      track.album ?? '', // Use empty string if album is undefined
      track.date ?? new Date().toISOString() // Use current date if missing
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
      WHERE artist = ? AND name = ? LIMIT 1
    `);
    const row = stmt.get(artist, name);
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