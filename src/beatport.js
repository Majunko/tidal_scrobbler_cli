import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { connectDB, executeSQL, existsAllTables } from './sql.js';
import { compareSongsAlreadyListened } from './utils.js';


// NOTE: Don't use top releases, because those are albums and is more tricky to scrape

const textFileName = 'beatport_tracks.txt';
const notFoundFileName = 'beatport_not_found.txt';
const htmlFallbackFile = process.env.BEATPORT_HTML_FILE;

function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function looksLikeCloudflareBlock(html) {
    return /just a moment|cloudflare|attention required|verify you are human/i.test(html);
}

function loadHtmlFromFallbackFile() {
    if (!htmlFallbackFile) return null;

    const resolvedPath = path.resolve(htmlFallbackFile);
    if (!fs.existsSync(resolvedPath)) {
        console.warn(`⚠️ BEATPORT_HTML_FILE points to a missing file: ${resolvedPath}`);
        return null;
    }

    console.log(`📄 Loading Beatport HTML from ${resolvedPath}`);
    return fs.readFileSync(resolvedPath, 'utf8');
}

function extractTrackTitle($, row) {
    const trackLink = $(row).find('a[href*="/track/"]').first();

    if (!trackLink.length) {
        const fallbackTitle = normalizeText($(row).text());
        return fallbackTitle ? { title: fallbackTitle, version: '' } : { title: '', version: '' };
    }

    const titleFromAttribute = normalizeText(trackLink.attr('title'));
    const releaseName = trackLink.find('[class*="ReleaseName"]').first();
    const rawTitle = titleFromAttribute || (releaseName.length ? normalizeText(releaseName.text()) : normalizeText(trackLink.text()));
    const cleanTitle = rawTitle.replace(/\s+Original Mix$/i, '').trim();

    return {
        title: cleanTitle,
        version: '',
    };
}

function extractArtists($, row) {
    const artists = [];
    const seen = new Set();

    $(row).find('a[href*="/artist/"]').each((_, artistEl) => {
        const artistName = normalizeText($(artistEl).text());
        const key = artistName.toLowerCase();
        if (artistName && !seen.has(key)) {
            seen.add(key);
            artists.push(artistName);
        }
    });

    return artists;
}

function extractTracksFromHtml(html) {
    const $ = cheerio.load(html);
    const tracks = [];
    const rowSelectors = [
        '[data-testid="tracks-list-item"]',
        '[data-testid*="tracks-list-item"]',
        '[class*="Lists-shared-style__Item"]',
        '[class*="TrackListItem"]',
        '[data-testid="tracks-table-row"]',
        'tr[data-testid*="track"]',
        '[role="row"][data-testid*="track"]',
    ];

    let rows = $();
    for (const selector of rowSelectors) {
        const found = $(selector);
        if (found.length > 0) {
            rows = found;
            break;
        }
    }

    rows.each((i, el) => {
        const { title, version } = extractTrackTitle($, el);
        const artists = extractArtists($, el);

        const fullTitle = title;

        if (artists.length > 0 && title) {
            tracks.push({
                name: fullTitle,
                artist: artists,
            });
        }
    });

    return tracks;
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
        let html = null;

        if (htmlFallbackFile) {
            html = loadHtmlFromFallbackFile();
        }

        if (!html) {
            console.log(`🚀 Fetching ${top100Url}...`);

            try {
                const response = await axios.get(top100Url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                    },
                    validateStatus: () => true,
                });

                if (response.status >= 200 && response.status < 300) {
                    html = response.data;
                } else {
                    console.warn(`⚠️ Beatport returned HTTP ${response.status}.`);
                    if (typeof response.data === 'string' && looksLikeCloudflareBlock(response.data)) {
                        console.warn('⚠️ The response looks like a Cloudflare challenge page.');
                    }
                }
            } catch (requestError) {
                console.warn(`⚠️ Network request failed: ${requestError.message}`);
            }
        }

        if (!html) {
            console.error('❌ No HTML available to parse. If you already captured the page source in a browser, set BEATPORT_HTML_FILE to that saved HTML file.');
            return [];
        }

        const tracks = extractTracksFromHtml(html);

        if (tracks.length === 0) {
            console.warn('⚠️ Beatport HTML was loaded, but no tracks were parsed. The page structure may have changed again.');
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

    // Keep the scraped Beatport ranking exactly as it appears on the page.
    const fileContent = allTracks
        .map(t => `${t.name} - ${Array.isArray(t.artist) ? t.artist.join(', ') : t.artist}`)
        .join('\n');

    if (allTracks.length > 0) {
        fs.writeFileSync(textFileName, `${fileContent}\n`);
    } else {
        console.warn(`⚠️ Skipping write to ${textFileName} because no tracks were scraped.`);
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
