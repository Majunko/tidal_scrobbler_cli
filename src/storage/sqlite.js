import { DatabaseSync } from 'node:sqlite';
import { normalize, titleNormalize } from '../utils/matching.js';
import { chunkArray } from '../utils/helpers.js';

const scrobbleDatabaseName = process.env.SCROBBLE_DATABASE_NAME;

// SQLite storage backend implementing the shared storage interface (see
// src/storage/factory.js). The underlying handle stays internal; consumers use the
// higher-level methods so the same code works against Supabase.
export const createSQLiteStorage = () => {
  let db = null;

  const connect = async () => {
    if (db) return db;
    db = new DatabaseSync(scrobbleDatabaseName);
    return db;
  };

  const executeSQL = async (sql, params = []) => {
    const statement = db.prepare(sql);
    const rows = statement.all(...params);
    // For SELECT queries, resolve with the rows
    if (sql.toLowerCase().startsWith('select')) {
      return rows;
    }
    // For INSERT, UPDATE, DELETE, etc., resolve without data
    return;
  };

  const createTracksTable = async () => {
    const sql = `CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      artist_normalized TEXT,
      name_normalized TEXT
    )`;
    return await executeSQL(sql);
  }

  const createMetaTable = async () => {
    const sql = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`;
    return await executeSQL(sql);
  }

  // Seeds a per-source import cursor for users upgrading from a DB that already
  // contains history (assumed to come from Last.fm), so the first run after the
  // upgrade stays incremental instead of re-fetching the full Last.fm history.
  const migrateMetaTable = async () => {
    await createMetaTable();
    const row = db.prepare(`SELECT COUNT(*) AS c FROM meta`).get();
    if (row && row.c === 0) {
      const latest = db.prepare(`SELECT MAX(date) AS max_date FROM tracks`).get();
      if (latest && latest.max_date) {
        const epoch = Math.floor(new Date(latest.max_date).getTime() / 1000);
        db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`).run('import_lastfm', String(epoch));
      }
    }
  }

  const columnExists = (table, column) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    return columns.some((c) => c.name === column);
  }

  // Backfills artist_normalized/name_normalized for rows that lack them, and
  // consolidates existing duplicates: keep the earliest row per normalized pair.
  const migrateTracksTable = async () => {
    if (!columnExists('tracks', 'artist_normalized')) {
      await executeSQL(`ALTER TABLE tracks ADD COLUMN artist_normalized TEXT`);
    }
    if (!columnExists('tracks', 'name_normalized')) {
      await executeSQL(`ALTER TABLE tracks ADD COLUMN name_normalized TEXT`);
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

    await executeSQL(`CREATE INDEX IF NOT EXISTS idx_tracks_normalized ON tracks (artist_normalized, name_normalized)`);
    // Enforces upsert dedup: INSERT ... ON CONFLICT DO NOTHING needs this to be
    // a UNIQUE index. Runs after consolidation so no existing rows conflict.
    await executeSQL(`CREATE UNIQUE INDEX IF NOT EXISTS uq_tracks_normalized ON tracks (artist_normalized, name_normalized)`);
  }

  const ensureSchema = async () => {
    const tables = await executeSQL(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      ['tracks']
    );
    if (!tables || tables.length < 1) {
      await createTracksTable();
    }
    await migrateTracksTable();
    await migrateMetaTable();
  }

  // Insert a batch of tracks, ignoring ones already stored (based on the
  // normalized artist/title pair). Returns the number of newly inserted rows.
  const upsertTracks = async (tracks) => {
    if (!tracks.length) return 0;
    let inserted = 0;
    for (const chunk of chunkArray(tracks, 500)) {
      const values = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(',');
      const sql =
        'INSERT INTO tracks (name, artist, album, date, name_normalized, artist_normalized) ' +
        `VALUES ${values} ON CONFLICT(artist_normalized, name_normalized) DO NOTHING`;
      const params = [];
      for (const track of chunk) {
        params.push(
          track.name,
          track.artist,
          track.album ?? '', // Use empty string if album is undefined
          track.date ?? new Date().toISOString(), // Use current date if missing
          titleNormalize(track.name),
          normalize(track.artist)
        );
      }
      const result = db.prepare(sql).run(...params);
      inserted += result.changes;
    }
    return inserted;
  }

  const getTracks = async () => db.prepare('SELECT name, artist FROM tracks').all();

  const getLatestTrack = async () =>
    db.prepare(`
      SELECT artist, album, name, date
      FROM tracks
      ORDER BY date DESC
      LIMIT 1
    `).get();

  const trackExists = async (artist, name) => {
    const row = db
      .prepare(`SELECT id FROM tracks WHERE artist_normalized = ? AND name_normalized = ? LIMIT 1`)
      .get(normalize(artist), titleNormalize(name));
    return !!row;
  }

  // Returns the last imported listened_at (Unix epoch seconds) for a source
  // ('lastfm' | 'listenbrainz'), or null if that source has never been imported.
  const importCursor = async (source) => {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(`import_${source}`);
    return row ? parseInt(row.value, 10) : null;
  }

  const setImportCursor = async (source, epochSeconds) => {
    const stmt = db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    stmt.run(`import_${source}`, String(Math.floor(epochSeconds)));
  }

  const close = () => {
    if (db) db.close();
    db = null;
  }

  return { connect, ensureSchema, upsertTracks, getTracks, getLatestTrack, trackExists, importCursor, setImportCursor, close };
}