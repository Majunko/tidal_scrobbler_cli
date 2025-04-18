import sqlite3 from 'sqlite3';
const lastFmDatabaseName = process.env.LASTFM_DATABASE_NAME;

// Function to connect to the SQLite database
export const connectDB = async () => {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(lastFmDatabaseName, (err) => {
      if (err) {
        console.error('Failed to connect to the database:', err.message);
        reject(err);
      } else {
        console.log('Connected to the database.');
        resolve(db);
      }
    });
  });
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
  return new Promise((resolve, reject) => {
    db.run(
      `
                INSERT OR IGNORE INTO tracks (artist, album, name, date)
                VALUES (?, ?, ?, ?)
            `,
      [track.artist, track.album, track.name, track.date],
      (err) => {
        if (err) {
          console.error('Failed to insert track:', err.message);
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

export const getLatestTrack = async (db) => {
  return new Promise((resolve, reject) => {
      db.get(`
          SELECT artist, album, name, date
          FROM tracks
          ORDER BY date DESC
          LIMIT 1
      `, (err, row) => {
          if (err) {
              console.error('Failed to get latest track:', err.message);
              reject(err);
          } else {
              resolve(row);
          }
      });
  });
}

export const checkTrackExists = async (db, artist, name) => {
  return new Promise((resolve, reject) => {
      db.get(`
          SELECT id
          FROM tracks
          WHERE artist = ? AND name = ? LIMIT 1
      `, [artist, name], (err, row) => {
          if (err) {
              console.error('Error checking if track exists:', err.message);
              reject(err);
          } else {
              resolve(!!row);
          }
      });
  });
}

export const executeSQL = async (db, sql, params = []) => {
  if (!db) {
    throw new Error('db parameter is required');
  }

  return new Promise((resolve, reject) => {
    const statement = db.prepare(sql);
    statement.all(...params, (err, rows) => {
      statement.finalize(); // Important to release resources
      if (err) {
        reject(err);
        return;
      }
      // For SELECT queries, resolve with the rows
      if (sql.toLowerCase().startsWith('select')) {
        resolve(rows);
      } else {
        // For INSERT, UPDATE, DELETE, etc., resolve without data (or with affected rows if needed)
        resolve();
      }
    });
  });
};