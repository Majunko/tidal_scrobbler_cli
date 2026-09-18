import http from 'http';
import { pathToFileURL } from 'url';
import { updateEnvVariable } from '../utils/env.js';
import { base64URLEncode, randomBytes32, sha256, openBrowser } from '../utils/helpers.js';

const DEFAULT_REDIRECT_URI = 'http://localhost:3000/callback';
// playlists.read is needed to list the user's playlists (setup wizard);
// playlists.write to modify them, and recommendations.read for the playlist feed.
const SCOPES = 'playlists.read playlists.write recommendations.read';

/**
 * Runs the full Tidal OAuth flow: builds the PKCE authorization URL, optionally
 * opens the browser, waits for the callback, exchanges the code for tokens and
 * saves them to `.env`. Resolves with the token payload.
 */
export async function runTidalOAuth({
  clientId,
  clientSecret,
  redirectUri = DEFAULT_REDIRECT_URI,
  port = 3000,
  shouldOpenBrowser = false,
} = {}) {
  const codeVerifier = base64URLEncode(randomBytes32());
  const codeChallenge = base64URLEncode(sha256(codeVerifier));

  const authUrl = `https://login.tidal.com/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES)}&code_challenge=${codeChallenge}&code_challenge_method=S256&lang=en&geo=US&campaignId=default`;

  console.log('Open this URL in your browser and authorize the app:');
  console.log(authUrl);

  if (shouldOpenBrowser) openBrowser(authUrl);

  return await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith('/callback')) return;

      try {
        const urlParams = new URLSearchParams(req.url.split('?')[1]);
        const code = urlParams.get('code');
        res.end('Authorization code received! You can close this window.');

        const tokenRes = await fetch('https://auth.tidal.com/v1/oauth2/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          }),
        });

        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
          reject(new Error(`OAuth failed: ${JSON.stringify(tokenData).slice(0, 200)}`));
          return;
        }

        // Save token to .env
        try {
          updateEnvVariable('TIDAL_ACCESS_TOKEN', tokenData.access_token);
          updateEnvVariable('TIDAL_REFRESH_TOKEN', tokenData.refresh_token);
          console.log('Access and refresh tokens saved to .env file.');
        } catch (err) {
          console.error('Failed to update .env file:', err.message);
        }

        server.close();
        resolve(tokenData);
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.listen(port, () => {
      console.log(`Listening for OAuth callback on http://localhost:${port}/callback`);
      console.log('If nothing happens, (re)authorize when you are redirected back.');
    });
  });
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  await runTidalOAuth({
    clientId: process.env.TIDAL_CLIENT_ID,
    clientSecret: process.env.TIDAL_CLIENT_SECRET,
  });
  process.exit(0);
}