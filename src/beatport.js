import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';


const textFileName = 'beatport_tracks.txt';
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
            const titlePrimary = $(el).find('.Tables-shared-style__ReleaseName-sc-74ae448d-5').contents().not('span').text().trim();
            const titleVersion = $(el).find('.Tables-shared-style__ReleaseName-sc-74ae448d-5 span').text().trim();
            
            const artists = [];
            $(el).find('.ArtistNames-sc-9ed174b1-0 a').each((_, artistEl) => {
                artists.push($(artistEl).text().trim());
            });

            const fullTitle = titleVersion.toLowerCase().includes('original mix') 
                ? titlePrimary 
                : `${titlePrimary} (${titleVersion})`;

            if (artists.length > 0 && titlePrimary) {
                // Return as objects so findDuplicateTracks can read them
                tracks.push({
                    name: fullTitle,
                    artist: artists // keeping as array for utils compatibility
                });
            }
        });

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
        'https://www.beatport.com/genre/techno-peak-time-driving/6/top-100',
        'https://www.beatport.com/genre/techno-peak-time-driving/6/hype-100'
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

runScraper();