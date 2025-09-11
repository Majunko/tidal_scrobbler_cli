import http from 'http';
import { updateEnvVariable, base64URLEncode, randomBytes32, sha256 } from './utils.js';

const clientId = process.env.TIDAL_CLIENT_ID;
const redirectUri = 'http://localhost:3000/callback'; // Use your registered redirect URI
const scopes = 'playlists.write recommendations.read'; // Use spaces to separate scopes

const codeVerifier = base64URLEncode(randomBytes32());
const codeChallenge = base64URLEncode(sha256(codeVerifier));

const authUrl = `https://login.tidal.com/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&code_challenge=${codeChallenge}&code_challenge_method=S256&lang=en&geo=US&campaignId=default`;

console.log('Open this URL in your browser and authorize the app:');
console.log(authUrl);

http.createServer(async (req, res) => {
  if (req.url.startsWith('/callback')) {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const code = urlParams.get('code');
    res.end('Authorization code received! You can close this window.');

    // Exchange code for access token
    const tokenRes = await fetch('https://auth.tidal.com/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${process.env.TIDAL_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });

    const tokenData = await tokenRes.json();

    // Save token to .env
    try {
      updateEnvVariable('TIDAL_ACCESS_TOKEN', tokenData.access_token);
      updateEnvVariable('TIDAL_REFRESH_TOKEN', tokenData.refresh_token);
      console.log('Access and refresh tokens saved to .env file.');
    } catch (err) {
      console.error('Failed to update .env file:', err.message);
    }

    process.exit(0);
  }
}).listen(3000, () => {
  console.log('Listening for OAuth callback on http://localhost:3000/callback');
});