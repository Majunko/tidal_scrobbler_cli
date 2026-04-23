import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import { connectDB, executeSQL, existsAllTables } from './sql.js';
import { compareSongsAlreadyListened } from './utils.js';


// NOTE: Don't use top releases, because those are albums and is more tricky to scrape

const textFileName = 'beatport_tracks.txt';
const notFoundFileName = 'beatport_not_found.txt';

function normalizeText(value) {
    return value.replace(/\s+/g, ' ').trim();
}

function extractTrackTitle($, row) {
    const titleCell = $(row).find('[role="cell"].title').first();
    const trackLink = titleCell.find('a[href^="/track/"]').first();

    if (!trackLink.length) return { title: '', version: '' };

    const releaseName = trackLink.find('[class*="ReleaseName"]').first();
    const rawTitle = releaseName.length ? normalizeText(releaseName.text()) : normalizeText(trackLink.text());

    const versionMatch = rawTitle.match(/\s+([^(]+?)\s*\(([^)]+)\)\s*$/);
    if (versionMatch) {
        return {
            title: normalizeText(versionMatch[1]),
            version: normalizeText(versionMatch[2]),
        };
    }

    const originalMixMatch = rawTitle.match(/^(.*?)\s+Original Mix$/i);
    if (originalMixMatch) {
        return {
            title: normalizeText(originalMixMatch[1]),
            version: 'Original Mix',
        };
    }

    return {
        title: rawTitle,
        version: '',
    };
}

function extractArtists($, row) {
    const titleCell = $(row).find('[role="cell"].title').first();
    const artists = [];
    const seen = new Set();

    titleCell.find('a[href^="/artist/"]').each((_, artistEl) => {
        const artistName = normalizeText($(artistEl).text());
        const key = artistName.toLowerCase();
        if (artistName && !seen.has(key)) {
            seen.add(key);
            artists.push(artistName);
        }
    });

    return artists;
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
 * Scrapes the Beatport Top 100 and RETURNS an array of track objects
 */
export async function scrapeTop100(top100Url) {
    try {
        console.log(`🚀 Fetching ${top100Url}...`);
        
        const { data } = await axios.get(top100Url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const $ = cheerio.load(data);
        const tracks = [];

        $('[data-testid="tracks-table-row"]').each((i, el) => {
            const { title, version } = extractTrackTitle($, el);
            const artists = extractArtists($, el);

            const fullTitle = version && !/original mix/i.test(version)
                ? `${title} (${version})`
                : title;

            if (artists.length > 0 && title) {
                // Return as objects so findDuplicateTracks can read them
                tracks.push({
                    name: fullTitle,
                    artist: artists // keeping as array for utils compatibility
                });
            }
        });

        if (tracks.length === 0) {
            console.warn('⚠️ Beatport rows were found, but no tracks were parsed. The page structure may have changed again.');
        }

        console.log(`✅ Scraped ${tracks.length} tracks.`);
        return tracks;

    } catch (error) {
        console.error('❌ Error scraping Beatport:', error.message);
        return [];
    }
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

    // 2. Filter out duplicates using a "Seen" Set
    // We create a unique key for each track to compare them
    const seen = new Set();
    const uniqueTracks = allTracks.filter(track => {
        const artistStr = Array.isArray(track.artist) ? track.artist.join(',') : track.artist;
        const key = `${track.name.toLowerCase()}|${artistStr.toLowerCase()}`;
        
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // 3. Create a complete file with no duplicates
    const fileContent = uniqueTracks
        .map(t => `${t.name} - ${Array.isArray(t.artist) ? t.artist.join(', ') : t.artist}`)
        .join('\n');

    fs.writeFileSync(textFileName, fileContent);
    
    console.log(`--- Stats ---`);
    console.log(`Total Scraped: ${allTracks.length}`);
    console.log(`Unique Saved:  ${uniqueTracks.length}`);
    console.log(`Duplicates:    ${allTracks.length - uniqueTracks.length}`);
}

async function runBeatportCheck() {
    let db;
    try {
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
    await runScraper();
    await runBeatportCheck();
}

runBeatportPipeline();
