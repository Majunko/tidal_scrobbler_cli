import fs from 'fs';
import { fetchNewestTracks } from './beatport_api.js';
import { connectDB, executeSQL, existsAllTables } from './sql.js';
import { compareSongsAlreadyListened } from './track_matcher.js';

const textFileName = 'beatport_tracks.txt';
const notFoundFileName = 'beatport_not_found.txt';

const GENRE_ID_FROM_URL = /\/genre\/[^/]+\/(\d+)\/(?:releases|top-100|hype-100)/i;

function extractGenreId(url) {
    const match = url.match(GENRE_ID_FROM_URL);
    return match ? Number(match[1]) : null;
}

function extractQueryParam(url, key) {
    try {
        return new URL(url).searchParams.get(key);
    } catch {
        return null;
    }
}

function extractSubGenreIds(url) {
    const raw = extractQueryParam(url, 'sub_genre_id');
    if (!raw) return [];
    return raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map(Number)
        .filter((value) => Number.isFinite(value));
}

function extractPerPage(url) {
    const value = Number(extractQueryParam(url, 'per_page'));
    return Number.isFinite(value) && value > 0 ? value : 150;
}

const parseBeatportLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const splitIndex = trimmed.lastIndexOf(' - ');
    if (splitIndex === -1) return null;

    const name = trimmed.slice(0, splitIndex).trim();
    const artist = trimmed.slice(splitIndex + 3).trim();

    if (!name || !artist) return null;
    return { name, artist };
};

const trackKey = (track) => `${track.name}|||${track.artist}`;

/**
 * Fetches the newest tracks from the Beatport releases tab via the official API
 * and RETURNS an array of track objects
 */
export async function scrapeNewReleases(releasesUrl) {
    const genreId = extractGenreId(releasesUrl);

    if (!genreId) {
        console.error(`❌ Could not determine genre id from URL: ${releasesUrl}`);
        return [];
    }

    const subGenreIds = extractSubGenreIds(releasesUrl);
    const count = extractPerPage(releasesUrl);

    try {
        const tracks = await fetchNewestTracks(genreId, subGenreIds, count);
        if (tracks.length > 0) {
            console.log(`✅ Fetched ${tracks.length} tracks from the Beatport releases API.`);
            return tracks;
        }
    } catch (error) {
        console.error(`❌ Error fetching Beatport releases: ${error.message}`);
        return [];
    }

    console.error('❌ The Beatport API returned no tracks.');
    return [];
}

async function runScraper() {
    const urls = [
        'https://www.beatport.com/genre/techno-raw-deep-hypnotic/92/releases?sub_genre_id=224%2C225',
        // 'https://www.beatport.com/genre/techno-peak-time-driving/6/top-100',
        // 'https://www.beatport.com/genre/techno-peak-time-driving/6/hype-100'
    ];

    // 1. Save all scraped data in a variable
    let allTracks = [];
    for (const url of urls) {
        const tracks = await scrapeNewReleases(url);
        allTracks = allTracks.concat(tracks);
    }

    // Keep the order returned by the API (newest releases first).
    const fileContent = allTracks
        .map(t => `${t.name} - ${Array.isArray(t.artist) ? t.artist.join(', ') : t.artist}`)
        .join('\n');

    if (allTracks.length > 0) {
        fs.writeFileSync(textFileName, `${fileContent}\n`);
    } else {
        console.warn(`⚠️ Skipping write to ${textFileName} because no tracks were fetched.`);
    }
    
    console.log(`--- Stats ---`);
    console.log(`Total Scraped: ${allTracks.length}`);
    console.log(`Saved:         ${allTracks.length}`);

    return allTracks.length;
}

async function runBeatportCheck() {
    let db;
    try {
        if (!fs.existsSync(textFileName)) {
            console.log(`No ${textFileName} file found. Skipping Beatport track check.`);
            return;
        }

        const raw = fs.readFileSync(textFileName, 'utf8');
        const beatportTracks = raw
            .split('\n')
            .map(parseBeatportLine)
            .filter(Boolean);

        if (beatportTracks.length === 0) {
            console.log(`No valid tracks found in ${textFileName}`);
            return;
        }

        db = await connectDB();
        await existsAllTables(db);

        const dbTracks = await executeSQL(db, 'SELECT name, artist FROM tracks');

        const foundTracks = compareSongsAlreadyListened(beatportTracks, dbTracks);
        const foundKeys = new Set(foundTracks.map(trackKey));

        const notFoundTracks = beatportTracks.filter((t) => !foundKeys.has(trackKey(t)));

        const output = notFoundTracks.map((t) => `${t.name} - ${t.artist}`).join('\n');
        fs.writeFileSync(notFoundFileName, output);

        console.log('--- Beatport Track Check ---');
        console.log(`Input tracks:   ${beatportTracks.length}`);
        console.log(`Found in DB:    ${foundTracks.length}`);
        console.log(`Not found:      ${notFoundTracks.length}`);
        console.log(`Output written: ${notFoundFileName}`);
    } catch (err) {
        console.error('Failed to check Beatport tracks:', err.message);
    } finally {
        if (db) db.close();
    }
}

async function runBeatportPipeline() {
    const scrapedCount = await runScraper();

    if (scrapedCount === 0) {
        console.log('Skipping Beatport track check because no tracks were scraped.');
        return;
    }

    await runBeatportCheck();
}

runBeatportPipeline();
