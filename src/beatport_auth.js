import axios from 'axios';
import { updateEnvVariable } from './utils.js';

export const API_BASE_URL = 'https://api.beatport.com/v4';
const TOKEN_URL = `${API_BASE_URL}/auth/o/token/`;
const LOGIN_URL = `${API_BASE_URL}/auth/login/`;
const AUTHORIZE_URL = `${API_BASE_URL}/auth/o/authorize/`;
const REDIRECT_URI = `${API_BASE_URL}/auth/o/post-message/`;
const DOCS_URL = `${API_BASE_URL}/docs/`;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

export const USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Public client_id shipped with Beatport's own API docs frontend (auto-scraped, with fallback)
const FALLBACK_CLIENT_ID = '0GIvkCltVIuPkkwSJHp6NDb3s0potTjLBQr388Dd';

function extractCookies(setCookieHeaders) {
    const cookies = {};
    for (const header of setCookieHeaders || []) {
        const match = header.match(/^([^=;]+)=([^;]*)/);
        if (match) cookies[match[1]] = match[2];
    }
    return cookies;
}

function formatCookies(cookies) {
    return Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
}

async function scrapeClientId() {
    const response = await axios.get(DOCS_URL, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        validateStatus: () => true,
    });

    if (response.status !== 200) return null;

    const jsPaths = [...response.data.matchAll(/src="(\/static\/btprt\/[^"]+\.js)"/g)].map((m) => m[1]);
    for (const jsPath of jsPaths) {
        const js = await axios.get(`https://api.beatport.com${jsPath}`, {
            headers: { 'User-Agent': USER_AGENT },
            validateStatus: () => true,
        });
        if (js.status !== 200) continue;
        const match = js.data.match(/API_CLIENT_ID:\s*['"]([^'"]+)['"]/);
        if (match) return match[1];
    }

    return null;
}

async function resolveClientId() {
    if (process.env.BEATPORT_API_CLIENT_ID) {
        return process.env.BEATPORT_API_CLIENT_ID;
    }
    try {
        const scraped = await scrapeClientId();
        if (scraped) return scraped;
    } catch {
        // ignore and fall back
    }
    return FALLBACK_CLIENT_ID;
}

function loadCachedToken() {
    const accessToken = process.env.BEATPORT_ACCESS_TOKEN;
    const refreshToken = process.env.BEATPORT_REFRESH_TOKEN;

    if (!accessToken && !refreshToken) return null;

    return {
        access_token: accessToken || null,
        refresh_token: refreshToken || null,
        expires_at: process.env.BEATPORT_TOKEN_EXPIRES_AT ? Number(process.env.BEATPORT_TOKEN_EXPIRES_AT) : null,
    };
}

function saveToken(token) {
    const envUpdates = {
        BEATPORT_ACCESS_TOKEN: token.access_token,
        BEATPORT_REFRESH_TOKEN: token.refresh_token || '',
        BEATPORT_TOKEN_EXPIRES_AT: String(token.expires_at),
    };

    for (const [key, value] of Object.entries(envUpdates)) {
        updateEnvVariable(key, value);
        process.env[key] = value;
    }

    return token;
}

export function clearCachedToken() {
    const envUpdates = {
        BEATPORT_ACCESS_TOKEN: '',
        BEATPORT_REFRESH_TOKEN: '',
        BEATPORT_TOKEN_EXPIRES_AT: '',
    };

    for (const [key, value] of Object.entries(envUpdates)) {
        updateEnvVariable(key, value);
        process.env[key] = value;
    }
}

function isTokenExpired(token) {
    if (!token?.access_token || !token.expires_at) return true;
    // Refresh a little before it actually expires
    return Date.now() >= token.expires_at - 60_000;
}

async function requestToken(bodyParams) {
    const clientId = await resolveClientId();
    const body = new URLSearchParams({ client_id: clientId, ...bodyParams });

    const response = await axios.post(TOKEN_URL, body.toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
        },
        validateStatus: () => true,
    });

    if (response.status >= 400) {
        const detail = typeof response.data === 'object'
            ? JSON.stringify(response.data)
            : response.data;
        throw new Error(`Beatport auth failed (HTTP ${response.status}): ${detail}`);
    }

    return response.data;
}

async function loginToWebsite() {
    const username = process.env.BEATPORT_USERNAME;
    const password = process.env.BEATPORT_PASSWORD;
    if (!username || !password) {
        throw new Error('Set BEATPORT_USERNAME and BEATPORT_PASSWORD in your .env file to use the Beatport API.');
    }

    const response = await axios.post(
        LOGIN_URL,
        { username, password },
        {
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'User-Agent': USER_AGENT,
            },
            maxRedirects: 0,
            validateStatus: () => true,
        },
    );

    if (response.status >= 400) {
        const detail = typeof response.data === 'object'
            ? JSON.stringify(response.data)
            : response.data;
        throw new Error(`Beatport login failed (HTTP ${response.status}): ${detail}`);
    }

    const cookies = extractCookies(response.headers['set-cookie']);
    if (Object.keys(cookies).length === 0) {
        throw new Error('Beatport login succeeded but returned no session cookies.');
    }

    return formatCookies(cookies);
}

async function obtainAuthorizationCode(sessionCookies) {
    const clientId = await resolveClientId();

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
    });

    const response = await axios.get(`${AUTHORIZE_URL}?${params.toString()}`, {
        headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            Cookie: sessionCookies,
        },
        maxRedirects: 0,
        validateStatus: () => true,
    });

    if (response.status !== 302) {
        const snippet = typeof response.data === 'string' ? response.data.slice(0, 300) : JSON.stringify(response.data);
        throw new Error(`Beatport authorization failed (HTTP ${response.status}): ${snippet}`);
    }

    const location = response.headers['location'];
    const match = String(location).match(/[?&]code=([^&]+)/);
    if (!match) {
        throw new Error(`Beatport authorization did not return a code. Location: ${location}`);
    }

    return decodeURIComponent(match[1]);
}

export async function obtainToken() {
    const cached = loadCachedToken();

    if (cached?.access_token && !isTokenExpired(cached)) {
        return cached;
    }

    if (cached?.refresh_token) {
        try {
            const data = await requestToken({
                grant_type: 'refresh_token',
                refresh_token: cached.refresh_token,
            });
            return saveAndReturnToken(data);
        } catch (err) {
            console.warn(`⚠️ Beatport token refresh failed: ${err.message}. Re-authenticating...`);
        }
    }

    const sessionCookies = await loginToWebsite();
    const code = await obtainAuthorizationCode(sessionCookies);

    const data = await requestToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: '',
    });

    return saveAndReturnToken(data);
}

function saveAndReturnToken(data) {
    const token = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || null,
        expires_at: Date.now() + (Number(data.expires_in) || DEFAULT_EXPIRES_IN_SECONDS) * 1000,
    };
    saveToken(token);
    return token;
}
