import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';

/**
 * Scrapes the Beatport Top 100 and saves it to a .txt file
 */
export async function scrapeAndSaveTop100(top100Url, textFileName) {
    try {
        console.log('🚀 Fetching Beatport Top 100...');
        
        const { data } = await axios.get(top100Url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const $ = cheerio.load(data);
        let trackList = '';
        let count = 0;

        // Note: Selectors on Beatport can shift; these target the standard grid/list items
        $('[data-testid="tracks-table-row"]').each((i, el) => {
            // 1. Get the Primary Title (e.g., "Labyrinth")
            const titlePrimary = $(el).find('.Tables-shared-style__ReleaseName-sc-74ae448d-5').contents().not('span').text().trim();
            
            // 2. Get the Version/Remix (e.g., "Original Mix" or "Alex Stein Remix")
            const titleVersion = $(el).find('.Tables-shared-style__ReleaseName-sc-74ae448d-5 span').text().trim();
            
            // 3. Get Artists
            const artists = [];
            $(el).find('.ArtistNames-sc-9ed174b1-0 a').each((_, artistEl) => {
                artists.push($(artistEl).text().trim());
            });

            // Clean data for Tidal matching: 
            // We keep the Remix info but usually strip "Original Mix" because it clutters search
            const artistString = artists.join(', ');
            let fullTitle = titleVersion.toLowerCase().includes('original mix') 
                ? titlePrimary 
                : `${titlePrimary} (${titleVersion})`;

            if (artistString && titlePrimary) {
                trackList += `${fullTitle} - ${artistString}\n`;
                count++;
            }
        });

        fs.writeFileSync(textFileName, trackList);
        
        console.log(`✅ Success! Saved ${count} tracks to ${textFileName}`);

    } catch (error) {
        console.error('❌ Error scraping Beatport:', error.message);
    }
}

// Techno (Raw / Deep / Hypnotic)
scrapeAndSaveTop100('https://www.beatport.com/genre/techno-raw-deep-hypnotic/92/top-100', 'techo_raw_100.txt');

// Techno (Peak Time / Driving)
scrapeAndSaveTop100('https://www.beatport.com/genre/techno-peak-time-driving/6/top-100', 'techo_peak_100.txt');