import { writeFileSync, readFileSync, existsSync } from 'fs';

export const checkEnvVariables = () => {
  const result = getEnvValidation(process.env);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
}

/**
 * Validates the app configuration against `env` (defaults to process.env)
 * without printing or exiting, so it can be reused by `npm run setup`.
 * Returns { ok, backend, missing, message }.
 */
export const getEnvValidation = (env = process.env) => {
  const dbBackend = (env.DB_BACKEND || 'sqlite').toLowerCase();

  if (dbBackend !== 'sqlite' && dbBackend !== 'supabase') {
    return {
      ok: false,
      backend: dbBackend,
      missing: ['DB_BACKEND'],
      message: `Missing environment variable: DB_BACKEND must be 'sqlite' or 'supabase' (got '${dbBackend}').`,
    };
  }

  const required = ['TIDAL_CLIENT_ID', 'TIDAL_CLIENT_SECRET', 'TIDAL_PLAYLIST_ID'];
  if (dbBackend === 'supabase') {
    required.push('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  } else {
    required.push('SCROBBLE_DATABASE_NAME');
  }

  const lastfmConfigured = !!(env.LASTFM_USERNAME && env.LASTFM_API_KEY);
  const listenbrainzConfigured = !!env.LISTENBRAINZ_USERNAME;
  if (!lastfmConfigured && !listenbrainzConfigured) {
    required.push('LASTFM_USERNAME/LASTFM_API_KEY or LISTENBRAINZ_USERNAME');
  }

  const missing = required.filter((variable) => !env[variable]);

  return {
    ok: missing.length === 0,
    backend: dbBackend,
    missing,
    message: missing.length > 0
      ? `Missing environment variables for ${dbBackend} backend: ${missing.join(', ')}`
      : null,
  };
}

/**
 * Creates or updates a KEY='value' entry in `.env`. Unlike updateEnvVariable,
 * it appends the key when it doesn't exist yet (used by the setup wizard).
 */
export const setEnvVariable = (key, newValue, { filePath = '.env' } = {}) => {
  const content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const escaped = String(newValue).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const line = `${key}='${escaped}'`;
  const regex = new RegExp(`^${key}=.*`, 'm');
  const nextContent = regex.test(content)
    ? content.replace(regex, line)
    : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`;
  writeFileSync(filePath, nextContent);
}

export const updateEnvVariable = (key, newValue) => {
  const envFilePath = '.env';
  let envFileContent = readFileSync(envFilePath, 'utf8');

  // Use a regular expression to find and replace the key-value pair
  const regex = new RegExp(`^${key}=.*`, 'm');
  if (regex.test(envFileContent)) {
      envFileContent = envFileContent.replace(regex, `${key}='${newValue}'`);
      console.log(`Updated ${key}\n`);
  } else {
      throw new Error(`Key ${key} not found in .env file.`);
  }

  // Write the updated content back to the .env file
  writeFileSync(envFilePath, envFileContent);
}