import axios from 'axios';
import { obtainToken, clearCachedToken, API_BASE_URL, USER_AGENT } from './beatport_auth.js';

function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeApiTracks(payload) {
    const list = Array.isArray(payload)
        ? payload
        : payload?.results || payload?.data || [];

    const tracks = [];
    for (const item of list) {
        const name = normalizeText(item?.name);
        if (!name) continue;

        let mix = normalizeText(item?.mix_name);
        if (/Original Mix$/i.test(mix)) mix = '';

        const fullTitle = [name, mix].filter(Boolean).join(' ');

        const artistNames = [
            ...(item?.artists ?? []).map(a => normalizeText(a?.name)),
            ...(item?.remixers ?? []).map(a => normalizeText(a?.name)),
        ].filter(Boolean);

        const seen = new Set();
        const artists = artistNames.filter((a) => {
            const key = a.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        if (artists.length > 0) {
            tracks.push({ name: fullTitle, artist: artists });
        }
    }

    return tracks;
}

// Paginates a catalog list endpoint and returns all raw items.
async function requestAll(url, params = {}, limit) {
    const token = await obtainToken();
    const results = [];
    let page = 1;

    while (true) {
        const response = await axios.get(url, {
            params: { ...params, page, per_page: 100 },
            headers: {
                Authorization: `Bearer ${token.access_token}`,
                Accept: 'application/json',
                'User-Agent': USER_AGENT,
            },
            validateStatus: () => true,
        });

        if (response.status === 401) {
            throw Object.assign(new Error('Token rejected'), { status: 401 });
        }
        if (response.status >= 400) {
            throw new Error(`Beatport API returned HTTP ${response.status}: ${JSON.stringify(response.data)}`);
        }

        const data = response.data;
        const items = Array.isArray(data) ? data : (data.results || []);
        results.push(...items);

        const total = data?.count ?? results.length;
        if ((limit && results.length >= limit) || results.length >= total || !data?.next) break;

        page += 1;
        if (page > 10) break; // safety cap
    }

    return results;
}

async function requestTopTracks(genreId, count) {
    const capped = Math.min(count, 100);
    const results = await requestAll(`${API_BASE_URL}/catalog/genres/${genreId}/top/${capped}/`);
    return normalizeApiTracks(results.slice(0, count));
}

async function retryOnAuth(fn) {
    try {
        return await fn();
    } catch (err) {
        if (err.status === 401) {
            console.warn('⚠️ Beatport token rejected. Re-authenticating once...');
            clearCachedToken();
            return await fn();
        }
        throw err;
    }
}

export async function fetchTopTracks(genreId, count = 100) {
    return retryOnAuth(() => requestTopTracks(genreId, count));
}
