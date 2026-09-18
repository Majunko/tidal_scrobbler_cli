import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', 'supabase', 'schema.sql');

const SCHEMA_HINT =
  'If SUPABASE_DB_URL is not set, create the tables manually:\n' +
  `  open your Supabase dashboard -> SQL Editor -> paste ${SCHEMA_PATH} and run it.`;

/**
 * Applies supabase/schema.sql against the project's Postgres database using a
 * direct/pooler connection string (SUPABASE_DB_URL, e.g.
 * postgresql://postgres.<ref>:<password>@...:5432/postgres).
 *
 * This is only needed by the migration tooling: PostgREST (the Data API used by
 * the app) cannot run DDL, so the tables are created here instead of in the SQL
 * editor. Idempotent — everything is CREATE TABLE IF NOT EXISTS.
 *
 * Returns the list of commands that were executed.
 */
export const ensureSupabaseSchema = async (connectionString) => {
  if (!connectionString) {
    return { applied: false, hint: SCHEMA_HINT };
  }

  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const sql = readFileSync(SCHEMA_PATH, 'utf8');
    const result = await client.query(sql);
    // Reload the PostgREST schema cache so the Data API sees the new tables
    // immediately (same as clicking Settings -> API -> Reload schema cache).
    await client.query("NOTIFY pgrst, 'reload schema'").catch(() => {});
    const commands = (Array.isArray(result) ? result : [result]).map((r) => r.command);
    return { applied: true, commands };
  } finally {
    await client.end().catch(() => {});
  }
};