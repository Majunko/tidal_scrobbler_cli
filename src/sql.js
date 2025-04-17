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