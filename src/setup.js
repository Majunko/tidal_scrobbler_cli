import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createClient } from '@supabase/supabase-js';
import { setEnvVariable, getEnvValidation } from './utils/env.js';
import { openBrowser } from './utils/helpers.js';
import { runTidalOAuth } from './tidal/oauth.js';

const ENV_PATH = '.env';
const EXAMPLE_PATH = '.env.example';
const SUPABASE_DB_URL_HINT =
  'In the dashboard click Connect (the wire/plug icon in the top bar), then\n' +
  '  PostgreSQL -> Connection string -> URI, pick Direct connection, set\n' +
  '  Connection method = Transaction pooler, and paste the full URI.';

const APP_ENV_KEYS = [
  'DB_BACKEND',
  'SCROBBLE_DATABASE_NAME',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
  'TIDAL_CLIENT_ID',
  'TIDAL_CLIENT_SECRET',
  'TIDAL_ACCESS_TOKEN',
  'TIDAL_REFRESH_TOKEN',
  'TIDAL_PLAYLIST_ID',
  'LASTFM_USERNAME',
  'LASTFM_API_KEY',
  'LISTENBRAINZ_USERNAME',
  'LISTENBRAINZ_API_TOKEN',
  'BEATPORT_USERNAME',
  'BEATPORT_PASSWORD',
  'BEATPORT_API_CLIENT_ID',
  'BEATPORT_ACCESS_TOKEN',
  'BEATPORT_REFRESH_TOKEN',
  'BEATPORT_TOKEN_EXPIRES_AT',
];

const rl = createInterface({ input: stdin, output: stdout });

const ask = async (prompt) => (await rl.question(prompt)).trim();

const askYesNo = async (prompt, defaultYes = false) => {
  const hint = defaultYes ? '(Y/n)' : '(y/N)';
  const answer = (await ask(`${prompt} ${hint}`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('y');
};

const section = (title) => console.log(`\n${'='.repeat(60)}\n  ${title}\n${'='.repeat(60)}`);

const status = (ok, label, detail = '') =>
  console.log(`  ${ok ? '[OK] ' : '[!!] '}${label}${detail ? ` — ${detail}` : ''}`);

let env = {};

function parseEnv(content) {
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    let raw = line.slice(eq + 1).trim();
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) raw = raw.slice(1, -1);
    else if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    out[key] = raw;
  }
  return out;
}

function reloadEnv() {
  env = existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, 'utf8')) : {};
  // Mirror the .env values into process.env so modules that read it lazily
  // (Tidal API, Supabase createClient, etc.) work with the freshly written values.
  for (const key of APP_ENV_KEYS) {
    if (key in env) process.env[key] = env[key];
  }
}

function saveEnvVar(key, value) {
  setEnvVariable(key, value);
  reloadEnv();
}

function bootstrapEnv() {
  if (existsSync(ENV_PATH)) return;
  if (existsSync(EXAMPLE_PATH)) {
    copyFileSync(EXAMPLE_PATH, ENV_PATH);
    console.log(`Created ${ENV_PATH} from ${EXAMPLE_PATH}.\n`);
  } else {
    writeFileSync(ENV_PATH, '');
    console.log(`Created an empty ${ENV_PATH}.`);
  }
}

async function promptTidal() {
  section('Tidal');
  console.log(
    'Create a Tidal app at https://developer.tidal.com/dashboard if you have not yet:\n' +
      '  - Redirect URL: http://localhost:3000/callback\n' +
      '  - Scopes: playlists.read, playlists.write\n'
  );

  let clientId = env.TIDAL_CLIENT_ID || '';
  const newId = await ask(`Tidal Client ID${clientId ? ` [current: ${clientId}]` : ''}: `);
  if (newId) {
    clientId = newId;
    saveEnvVar('TIDAL_CLIENT_ID', clientId);
  }

  let clientSecret = env.TIDAL_CLIENT_SECRET || '';
  const newSecret = await ask(`Tidal Client Secret${clientSecret ? ' [current: set]' : ''}: `);
  if (newSecret) {
    clientSecret = newSecret;
    saveEnvVar('TIDAL_CLIENT_SECRET', clientSecret);
  }

  if (clientId && clientSecret) {
    if (await askYesNo('Authorize your Tidal account now?', true)) {
      try {
        await runTidalOAuth({ clientId, clientSecret, shouldOpenBrowser: true });
        reloadEnv();
        console.log('Tokens saved.\n');
      } catch (err) {
        console.warn(`OAuth failed: ${err.message}\n`);
      }
    }
  }

  if (env.TIDAL_ACCESS_TOKEN) {
    const { getUserPlaylists } = await import('./tidal/api.js');
    if (await askYesNo('List your playlists so you can pick the target one?', true)) {
      try {
        const playlists = await getUserPlaylists();
        if (playlists.length > 0) {
          console.log('\nYour playlists:');
          playlists.forEach((p, i) => console.log(`  ${String(i + 1).padStart(3)}. ${p.title} [${p.privacy}]`));
          const pickAnswer = await ask(`Select playlist number (1-${playlists.length}), or leave blank to paste an ID: `);
          const idx = parseInt(pickAnswer, 10);
          if (idx >= 1 && idx <= playlists.length) {
            saveEnvVar('TIDAL_PLAYLIST_ID', playlists[idx - 1].id);
            console.log(`Selected: "${playlists[idx - 1].title}" (${playlists[idx - 1].id})\n`);
          }
        } else {
          console.log('No playlists found for this account.');
        }
      } catch (err) {
        console.warn(`Could not list playlists: ${err.message}`);
      }
    }
  }

  const currentPlaylist = env.TIDAL_PLAYLIST_ID || '';
  const playlistId = await ask(
    `Tidal Playlist ID${currentPlaylist ? ` [current: ${currentPlaylist}]` : ' (from the playlist URL)'}: `
  );
  if (playlistId) saveEnvVar('TIDAL_PLAYLIST_ID', playlistId);
}

async function promptScrobbleSource() {
  section('Listening history source');
  console.log('The script learns what you have already listened to from Last.fm or\nListenBrainz. ListenBrainz takes priority when both are configured.\n');

  const lastfmSet = !!(env.LASTFM_USERNAME && env.LASTFM_API_KEY);
  const lbSet = !!env.LISTENBRAINZ_USERNAME;
  const defaultLb = lbSet || !lastfmSet;

  if (await askYesNo('Configure ListenBrainz?', defaultLb)) {
    const username = await ask(`ListenBrainz username${env.LISTENBRAINZ_USERNAME ? ` [current: ${env.LISTENBRAINZ_USERNAME}]` : ''}: `);
    if (username) saveEnvVar('LISTENBRAINZ_USERNAME', username);
    if (env.LISTENBRAINZ_USERNAME && await askYesNo('Add your ListenBrainz API token? (optional, higher rate limits)', false)) {
      const token = await ask('ListenBrainz API token (https://listenbrainz.org/settings/): ');
      if (token) saveEnvVar('LISTENBRAINZ_API_TOKEN', token);
    }
  }

  if (await askYesNo('Configure Last.fm?', !lbSet)) {
    const username = await ask(`Last.fm username${env.LASTFM_USERNAME ? ` [current: ${env.LASTFM_USERNAME}]` : ''}: `);
    if (username) saveEnvVar('LASTFM_USERNAME', username);
    const apiKey = await ask(`Last.fm API key (https://www.last.fm/api/account/create)${env.LASTFM_API_KEY ? ' [current: set]' : ''}: `);
    if (apiKey) saveEnvVar('LASTFM_API_KEY', apiKey);
  }
}

async function promptDatabase() {
  section('Database');
  console.log(`Current backend: ${env.DB_BACKEND || 'sqlite'}`);

  if (await askYesNo('Use Supabase to store your history? (no = local SQLite file)', false)) {
    const url = await ask(`Supabase Project URL (Settings -> API)${env.SUPABASE_URL ? ` [current: ${env.SUPABASE_URL}]` : ''}: `);
    if (url) saveEnvVar('SUPABASE_URL', url);
    const serviceKey = await ask(`Supabase service_role key${env.SUPABASE_SERVICE_ROLE_KEY ? ' [current: set]' : ''}: `);
    if (serviceKey) saveEnvVar('SUPABASE_SERVICE_ROLE_KEY', serviceKey);

    console.log(`\n${SUPABASE_DB_URL_HINT}`);
    const dbUrl = await ask(`Postgres connection string (SUPABASE_DB_URL)${env.SUPABASE_DB_URL ? ' [current: set]' : ''}: `);
    if (dbUrl) saveEnvVar('SUPABASE_DB_URL', dbUrl);

    saveEnvVar('DB_BACKEND', 'supabase');

    const scrobbleDb = env.SCROBBLE_DATABASE_NAME || 'scrobbles.db';
    if (existsSync(scrobbleDb) && await askYesNo(`Copy your existing local history (${scrobbleDb}) into Supabase now?`, false)) {
      try {
        const child = spawn(process.execPath, ['--env-file=.env', 'src/migrate_to_supabase.js'], {
          cwd: process.cwd(),
          env: process.env,
          stdio: 'inherit',
        });
        await once(child, 'exit');
      } catch (err) {
        console.warn(`Migration failed: ${err.message}`);
      }
    }
  } else {
    saveEnvVar('DB_BACKEND', 'sqlite');
    if (!env.SCROBBLE_DATABASE_NAME) saveEnvVar('SCROBBLE_DATABASE_NAME', 'scrobbles.db');
  }
}

async function promptBeatport() {
  section('Beatport Top 100 (optional)');
  console.log('Only needed for the optional Top-100 scraper (npm run beatport).\n');

  if (await askYesNo('Configure Beatport?', false)) {
    const username = await ask(`Beatport username${env.BEATPORT_USERNAME ? ` [current: ${env.BEATPORT_USERNAME}]` : ''}: `);
    if (username) saveEnvVar('BEATPORT_USERNAME', username);
    const password = await ask(`Beatport password${env.BEATPORT_PASSWORD ? ' [current: set]' : ''}: `);
    if (password) saveEnvVar('BEATPORT_PASSWORD', password);
  }
}

async function runChecks() {
  section('Configuration check');

  const result = getEnvValidation(env);
  if (result.ok) {
    status(true, 'Required variables present', `backend: ${result.backend}`);
  } else {
    status(false, 'Required variables', result.message || result.missing.join(', '));
  }

  if (env.TIDAL_ACCESS_TOKEN && env.TIDAL_PLAYLIST_ID) {
    try {
      const { getPlaylistTrackIds } = await import('./tidal/api.js');
      const ids = await getPlaylistTrackIds(env.TIDAL_PLAYLIST_ID);
      status(true, 'Tidal playlist', `reachable, ${ids.size} track(s)`);
    } catch (err) {
      status(false, 'Tidal playlist', err.message);
    }
  } else {
    status(false, 'Tidal playlist', 'missing access token or TIDAL_PLAYLIST_ID');
  }

  if (env.LISTENBRAINZ_USERNAME) {
    try {
      const resp = await fetch(`https://api.listenbrainz.org/1/user/${encodeURIComponent(env.LISTENBRAINZ_USERNAME)}/listens?count=1`);
      const data = await resp.json();
      const ok = resp.ok && Array.isArray(data?.payload?.listens);
      status(ok, 'ListenBrainz', ok ? `user ${env.LISTENBRAINZ_USERNAME}` : data?.error || `HTTP ${resp.status}`);
    } catch (err) {
      status(false, 'ListenBrainz', err.message);
    }
  }

  if (env.LASTFM_USERNAME && env.LASTFM_API_KEY) {
    try {
      const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(env.LASTFM_USERNAME)}&api_key=${env.LASTFM_API_KEY}&format=json&limit=1`;
      const resp = await fetch(url);
      const data = await resp.json();
      const ok = resp.ok && !!data.recenttracks;
      status(ok, 'Last.fm', ok ? `user ${env.LASTFM_USERNAME}` : data.message || `HTTP ${resp.status}`);
    } catch (err) {
      status(false, 'Last.fm', err.message);
    }
  }

  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
      const { error } = await client.from('tracks').select('*').limit(1);
      const missing = error && /PGRST205/.test(`${error.code || ''} ${error.message || ''}`);
      status(!missing, 'Supabase', missing ? 'tables missing (run migrate-to-supabase) or schema cache not reloaded' : 'reachable');
    } catch (err) {
      status(false, 'Supabase', err.message);
    }
  } else {
    status(false, 'Supabase', 'skipped (not configured)');
  }

  return result.ok;
}

async function main() {
  const checkOnly = process.argv.includes('--check') || process.argv.includes('-c');

  bootstrapEnv();
  reloadEnv();

  if (checkOnly) {
    const ok = await runChecks();
    rl.close();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  console.log('Welcome to the Tidal Scrobbler setup. Blank answers keep the\ncurrent value; press Ctrl+C at any time to cancel.\n');

  await promptTidal();
  await promptScrobbleSource();
  await promptDatabase();
  await promptBeatport();

  const ok = await runChecks();

  console.log('\nNext steps:');
  console.log('  npm start                 # run the main playlist cleanup');
  console.log('  npm run tidal-migrate     # copy Beatport picks into your Tidal playlist');
  console.log('  npm run setup -- --check  # re-check this configuration any time');

  rl.close();
  process.exitCode = ok ? 0 : 1;
}

await main();