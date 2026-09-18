import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'url';
import { createSupabaseStorage } from './storage/supabase.js';
import { ensureSupabaseSchema } from './storage/schema.js';
import { chunkArray } from './utils/helpers.js';

const scrobbleDatabaseName = process.env.SCROBBLE_DATABASE_NAME;
const supabaseDbUrl = process.env.SUPABASE_DB_URL;
const dryRun = process.argv.includes('--dry-run');

// One-off migration: copies the local SQLite scrobbles (tracks + import cursors)
// into a Supabase project. Idempotent: tracks already present (same normalized
// artist/title) are skipped, so it is safe to run more than once.
async function migrate() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to migrate to Supabase.');
    process.exit(1);
  }
  if (!scrobbleDatabaseName) {
    console.error('SCROBBLE_DATABASE_NAME is not set. Point it at the local SQLite file to copy from.');
    process.exit(1);
  }

  const local = new DatabaseSync(scrobbleDatabaseName);
  const tracks = local.prepare('SELECT artist, album, name, date FROM tracks ORDER BY date').all();
  const meta = local.prepare(`SELECT key, value FROM meta`).all();

  console.log(`Source database:  ${scrobbleDatabaseName}`);
  console.log(`Tracks found:     ${tracks.length}`);
  console.log(`Meta keys found:  ${meta.length}`);
  console.log(`Dry run:          ${dryRun ? 'ON' : 'OFF'}\n`);

  if (dryRun) {
    local.close();
    console.log('DRY RUN: nothing was written to Supabase.');
    return;
  }

  // PostgREST (Data API) cannot run DDL, so use a direct Postgres connection
  // (SUPABASE_DB_URL) to create/migrate the tables automatically when provided.
  if (supabaseDbUrl) {
    const { applied, commands, hint } = await ensureSupabaseSchema(supabaseDbUrl);
    if (applied) {
      console.log(`Supabase schema applied via SUPABASE_DB_URL${commands.length ? ` (${commands.join(', ')})` : ' (no-op)'}.\n`);
    } else {
      console.warn(`Could not apply the schema: ${hint}\n`);
    }
  }

  const supabase = createSupabaseStorage();
  await supabase.connect();
  await supabase.ensureSchema();

  let inserted = 0;
  for (const chunk of chunkArray(tracks, 200)) {
    inserted += await supabase.upsertTracks(chunk);
  }

  // Copy per-source import cursors (import_lastfm, import_listenbrainz) so the
  // next run stays incremental instead of re-backfilling full history.
  for (const row of meta) {
    const m = /^import_(.+)$/.exec(row.key);
    if (m) {
      await supabase.setImportCursor(m[1], Number(row.value));
    }
  }

  console.log(`Written: ${inserted} new track(s) to Supabase (already-present tracks were skipped).`);
  console.log(`Copied:  ${meta.length} meta key(s).`);

  local.close();
  await supabase.close();
  console.log('\nMigration complete. Switch to Supabase by setting DB_BACKEND=supabase in .env .');
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  migrate().catch((error) => {
    console.error('\nMigration failed:', error.message);
    process.exit(1);
  });
}