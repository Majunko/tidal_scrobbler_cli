import { createClient } from '@supabase/supabase-js';
import { normalize, titleNormalize } from '../utils/matching.js';
import { chunkArray } from '../utils/helpers.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SCHEMA_HINT =
  '\nRunning the setup in https://github.com/Majunko/tidal_scrobbler_cli/blob/main/supabase/schema.sql\n' +
  "(open your Supabase dashboard -> SQL Editor -> paste the file and run it) and make sure\n" +
  'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set (Settings -> API).';

// Supabase storage backend implementing the shared storage interface (see
// src/storage/factory.js). Backed by Postgres; the schema is provisioned by running
// supabase/schema.sql once (pgREST cannot run DDL).
export const createSupabaseStorage = () => {
  let client = null;

  const connect = async () => {
    if (client) return client;
    if (!supabaseUrl || !supabaseServiceRoleKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when DB_BACKEND=supabase.');
    }
    client = createClient(supabaseUrl, supabaseServiceRoleKey);
    return client;
  };

  const tableExists = async (table) => {
    // Deliberately NOT a head query: PostgREST ignores HEAD/head requests for
    // missing relations (returns empty with status 200), only a normal select
    // surfaces PGRST205 ("Could not find the table ... in the schema cache").
    const { error } = await client.from(table).select('*').limit(1);
    // PGRST116 = not found (no rows) is fine — the relation exists.
    const isMissing = error && /PGRST205/.test(`${error.code || ''} ${error.message || ''}`);
    return !isMissing;
  };

  const ensureSchema = async () => {
    await connect();
    const tables = await Promise.all([tableExists('tracks'), tableExists('meta')]);
    if (!tables[0]) {
      throw new Error(`Supabase table "tracks" does not exist.${SCHEMA_HINT}`);
    }
    if (!tables[1]) {
      throw new Error(`Supabase table "meta" does not exist.${SCHEMA_HINT}`);
    }
  };

  // Insert a batch of tracks, ignoring ones already stored (based on the
  // normalized artist/title pair). Returns the number of newly inserted rows.
  const upsertTracks = async (tracks) => {
    if (!tracks.length) return 0;
    await connect();

    // ignoreDuplicates upserts return no payload (data is null even on 201), so
    // the inserted count is derived from the table count before/after. Cheap:
    // one COUNT(*) per call regardless of batch size.
    const { count: countBefore } = await client.from('tracks').select('id', { count: 'exact', head: true });

    for (const chunk of chunkArray(tracks, 200)) {
      const rows = chunk.map((track) => ({
        name: track.name,
        artist: track.artist,
        album: track.album ?? '',
        date: track.date ?? new Date().toISOString(),
        name_normalized: titleNormalize(track.name),
        artist_normalized: normalize(track.artist),
      }));
      const { error } = await client
        .from('tracks')
        .upsert(rows, { onConflict: 'artist_normalized,name_normalized', ignoreDuplicates: true });
      if (error) throw error;
    }

    const { count: countAfter } = await client.from('tracks').select('id', { count: 'exact', head: true });
    return (countAfter || 0) - (countBefore || 0);
  };

  const getTracks = async () => {
    await connect();
    const out = [];
    const PAGE_SIZE = 1000;
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await client
        .from('tracks')
        .select('name, artist')
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < PAGE_SIZE) break;
    }
    return out;
  };

  const getLatestTrack = async () => {
    await connect();
    const { data, error } = await client
      .from('tracks')
      .select('artist, album, name, date')
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  };

  const trackExists = async (artist, name) => {
    await connect();
    const { data, error } = await client
      .from('tracks')
      .select('id')
      .eq('artist_normalized', normalize(artist))
      .eq('name_normalized', titleNormalize(name))
      .maybeSingle();
    if (error) throw error;
    return !!data;
  };

  const importCursor = async (source) => {
    await connect();
    const { data, error } = await client
      .from('meta')
      .select('value')
      .eq('key', `import_${source}`)
      .maybeSingle();
    if (error) throw error;
    return data ? parseInt(data.value, 10) : null;
  };

  const setImportCursor = async (source, epochSeconds) => {
    await connect();
    const { error } = await client
      .from('meta')
      .upsert({ key: `import_${source}`, value: String(Math.floor(epochSeconds)) }, { onConflict: 'key' });
    if (error) throw error;
  };

  const close = async () => {
    client = null;
  };

  return { connect, ensureSchema, upsertTracks, getTracks, getLatestTrack, trackExists, importCursor, setImportCursor, close };
}