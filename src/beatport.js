import fs from 'fs';
import { pathToFileURL } from 'url';
import { fetchTopTracks } from './beatport_api.js';
import { connectDB, executeSQL, existsAllTables } from './sql.js';
import { compareSongsAlreadyListened } from './track_matcher.js';
import { parseBeatportLine } from './utils.js';

const textFileName = 'beatport_scraped.txt';
const notFoundFileName = 'beatport_pending.txt';
const beatportUrlsFile = 'beatport_urls.txt';
const defaultBeatportUrl = 'https://www.beatport.com/genre/techno-raw-deep-hypnotic/92/top-100';

const GENRE_ID_FROM_URL = /\/genre\/[^/]+\/(\d+)\/top-100/i;

function extractGenreId(url) {
    const match = url.match(GENRE_ID_FROM_URL);
    return match ? Number(match[1]) : null;
}

function resolveBeatportUrls() {
    try {
        if (fs.existsSync(beatportUrlsFile)) {
            const urls = fs
                .readFileSync(beatportUrlsFile, 'utf8')
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line && !line.startsWith('#'));
            if (urls.length > 0) return urls;
        }
    } catch (error) {
        console.warn(`⚠️ Could not read ${beatportUrlsFile}: ${error.message}`);
    }
    return [defaultBeatportUrl];
}

const trackKey = (track) => `${track.name}|||${track.artist}`;

/**
 * Fetches the top 100 tracks of a Beatport genre via the official API and
 * RETURNS an array of track objects
 */
export async function scrapeGenre(genreUrl) {
    const genreId = extractGenreId(genreUrl);

    if (!genreId) {
        console.error(`❌ Could not determine genre id from URL: ${genreUrl}`);
        return [];
    }

    try {
        const tracks = await fetchTopTracks(genreId, 100);
        if (tracks.length > 0) {
            console.log(`✅ Fetched ${tracks.length} tracks from the Beatport API (top-100).`);
            return tracks;
        }
    } catch (error) {
        console.error(`❌ Error fetching Beatport: ${error.message}`);
        return [];
    }

    console.error('❌ The Beatport API returned no tracks.');
    return [];
}

async function runScraper() {
    const urls = resolveBeatportUrls();
    console.log(`Scraping ${urls.length} URL(s):`);
    urls.forEach((url) => console.log(`  - ${url}`));

    // 1. Save all scraped data in a variable, deduping across the lists
    let allTracks = [];
    const seen = new Set();
    for (const url of urls) {
        const tracks = await scrapeGenre(url);
        for (const t of tracks) {
            const key = trackKey(t);
            if (!seen.has(key)) {
                seen.add(key);
                allTracks.push(t);
            }
        }
    }

    // Keep the order returned by the API (top-100 first).
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

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
    runBeatportPipeline().catch((error) => {
        console.error('Beatport pipeline failed:', error.message);
        process.exit(1);
    });
}
