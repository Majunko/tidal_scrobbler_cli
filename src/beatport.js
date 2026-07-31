import fs from 'fs';
import { fetchTopTracks } from './beatport_api.js';
import { connectDB, executeSQL, existsAllTables } from './sql.js';
import { compareSongsAlreadyListened } from './utils.js';

const textFileName = 'beatport_tracks.txt';
const notFoundFileName = 'beatport_not_found.txt';

const GENRE_ID_FROM_URL = /\/genre\/[^/]+\/(\d+)\/(?:top-100|hype-100)/i;

function extractGenreId(url) {
    const match = url.match(GENRE_ID_FROM_URL);
    return match ? Number(match[1]) : null;
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
 * Fetches the Beatport Top 100 via the official API and RETURNS an array of track objects
 */
export async function scrapeTop100(top100Url) {
    const genreId = extractGenreId(top100Url);

    if (!genreId) {
        console.error(`❌ Could not determine genre id from URL: ${top100Url}`);
        return [];
    }

    try {
        const tracks = await fetchTopTracks(genreId);
        if (tracks.length > 0) {
            console.log(`✅ Fetched ${tracks.length} tracks from the Beatport API.`);
            return tracks;
        }
    } catch (error) {
        console.error(`❌ Error fetching Beatport Top 100: ${error.message}`);
        return [];
    }

    console.error('❌ The Beatport API returned no tracks.');
    return [];
}

async function runScraper() {
    const urls = [
        'https://www.beatport.com/genre/techno-raw-deep-hypnotic/92/top-100',
        // 'https://www.beatport.com/genre/techno-peak-time-driving/6/top-100',
        // 'https://www.beatport.com/genre/techno-peak-time-driving/6/hype-100'
    ];

    // 1. Save all scraped data in a variable
    let allTracks = [];
    for (const url of urls) {
        const tracks = await scrapeTop100(url);
        allTracks = allTracks.concat(tracks);
    }

    // Keep the Beatport ranking exactly as it appears on the page.
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
