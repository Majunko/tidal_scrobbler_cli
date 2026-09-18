import { createSQLiteStorage } from './sqlite.js';
import { createSupabaseStorage } from './supabase.js';

// Storage factory. The backend is chosen with DB_BACKEND in .env:
//   DB_BACKEND=sqlite   (default) local SQLite file (SCROBBLE_DATABASE_NAME)
//   DB_BACKEND=supabase remote Postgres via Supabase (SUPABASE_URL/KEY)
// Both backends expose the same async interface:
//   connect(), ensureSchema(), getTracks(), upsertTracks(tracks),
//   trackExists(artist, name), getLatestTrack(),
//   importCursor(source), setImportCursor(source, epoch), close()
export const createStorage = () => {
  const backend = (process.env.DB_BACKEND || 'sqlite').toLowerCase();
  if (backend === 'sqlite') return createSQLiteStorage();
  if (backend === 'supabase') return createSupabaseStorage();
  throw new Error(`Unknown DB_BACKEND '${backend}'. Use 'sqlite' or 'supabase'.`);
};