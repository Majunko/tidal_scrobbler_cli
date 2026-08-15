import fs from 'fs';
import Fuse from 'fuse.js';
import { pathToFileURL } from 'url';
import { searchTracks, addTracksToPlaylist, getPlaylistTrackIds, getRequestCount } from './tidal_api.js';
import { normalize, normalizeArtistSet, isArtistSetMatch, removeDiacritics } from './track_matcher.js';

const SOURCE_FILE = 'beatport_pending.txt';
const IMPORTED_FILE = 'tidal_imported.txt';
const REVIEW_FILE = 'tidal_needs_review.txt';
const NOT_FOUND_FILE = 'tidal_not_found.txt';

const dryRun = process.argv.includes('--dry-run');
const playlistId = process.env.TIDAL_PLAYLIST_ID;

// Tracks are processed in parallel, but the shared rate limiter in tidal_api.js
// keeps the total request rate within Tidal's limits.
const CONCURRENCY = 3;

const normalizeTitle = (title) =>
  normalize(removeDiacritics(String(title)))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const MIX_KEYWORDS = /(mix|edit|remix|version|dub|reprise|rework|acapella|instrumental|radio|extended|club|original|vocal|bonus|intro|outro|clean|dirty)/i;

// Removes mix/remix/version markers ("(Original Mix)", " - Extended Mix", ...)
// so a Beatport title can be matched against a differently-named Tidal version.
const stripMixMarkers = (title) => {
  let t = String(title);
  t = t.replace(/[\[\(][^\]\)]*[\]\)]/g, (m) => (MIX_KEYWORDS.test(m) ? ' ' : m));
  t = t.replace(/\s*[-–—]\s*[^-–—]+$/g, (m) => (MIX_KEYWORDS.test(m) ? ' ' : m));
  return t.replace(/\s+/g, ' ').trim();
};

const titleMatch = (beatportName, tidalTrack) => {
  const a = normalizeTitle(beatportName);
  const b = normalizeTitle(tidalTrack.fullTitle);
  if (!a || !b) return false;

  if (a === b) return true;

  const aS = stripMixMarkers(a);
  const bS = stripMixMarkers(b);
  if (aS && bS && aS === bS) return true;

  // Fuzzy fallback only for reasonably short titles.
  if (a.length > 60 || b.length > 60) return false;

  const fuse = new Fuse([bS || b], { includeScore: true, threshold: 0.05 });
  const [result] = fuse.search(aS || a);
  return Boolean(result && result.score !== undefined && result.score <= 0.05);
};

const isExactTitle = (name, track) => {
  const a = normalizeTitle(name);
  const b = normalizeTitle(track.fullTitle);
  if (a && b && a === b) return true;
  const aS = stripMixMarkers(a);
  const bS = stripMixMarkers(b);
  return Boolean(aS && bS && aS === bS);
};

const parseBeatportLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const splitIndex = trimmed.lastIndexOf(' - ');
  if (splitIndex === -1) return null;

  const name = trimmed.slice(0, splitIndex).trim();
  const artist = trimmed.slice(splitIndex + 3).trim();

  if (!name || !artist) return null;
  return { name, artist, line: trimmed };
};

// Cache search results by normalized query (dedupes in-flight requests too).
const searchCache = new Map();
const cachedSearch = (query) => {
  const key = query.toLowerCase().trim();
  if (!searchCache.has(key)) {
    const promise = searchTracks(query).catch((error) => {
      searchCache.delete(key);
      throw error;
    });
    searchCache.set(key, promise);
  }
  return searchCache.get(key);
};

let failedSearches = 0;

const scoreCandidates = (candidates, name, artist) =>
  candidates.map((c) => ({
    ...c,
    artistOk: isArtistSetMatch(normalizeArtistSet(artist), normalizeArtistSet(c.artists)),
    titleOk: titleMatch(name, c),
  }));

// Key that ignores artist order/casing and mix markers, so identical tracks
// published twice on Tidal (different ids, same title + artists) count once.
const matchKey = (c) => {
  const title = stripMixMarkers(normalizeTitle(c.fullTitle));
  const artists = [...normalizeArtistSet(c.artists)].sort().join(',');
  return `${title}|${artists}`;
};

const dedupeMatches = (matches) => {
  const seen = new Map();
  for (const m of matches) {
    const key = matchKey(m);
    if (!seen.has(key)) seen.set(key, m);
  }
  return [...seen.values()];
};

// Tries the combined query first and only falls back to artist/title queries when
// the accumulated candidates are not decisive, avoiding ~2/3 of the requests.
export async function findCandidates(name, artist) {
  const seen = new Map();
  const addResults = (results) => {
    for (const track of results) {
      if (!seen.has(track.id)) seen.set(track.id, track);
    }
  };

  const queries = [`${name} ${artist}`, artist, name];

  for (const query of queries) {
    try {
      addResults(await cachedSearch(query));
    } catch {
      failedSearches++;
    }

    const scored = scoreCandidates([...seen.values()], name, artist);
    const matches = scored.filter((c) => c.artistOk && c.titleOk);
    const distinct = dedupeMatches(matches);

    // A single distinct exact title+artist match is decisive: skip the remaining queries.
    if (distinct.length === 1 && isExactTitle(name, distinct[0])) break;
    // Multiple distinct matches need manual review either way: stop early.
    if (distinct.length > 1) break;
  }

  const scored = scoreCandidates([...seen.values()], name, artist);
  return { scored };
}

export const classify = (name, scored) => {
  const matches = scored.filter((c) => c.artistOk && c.titleOk);
  const distinct = dedupeMatches(matches);
  // Two Tidal ids for the same title+artists are the same track (e.g. released
  // on two albums): import it instead of flagging a false "needs review".
  if (distinct.length === 1) {
    return { type: 'import', id: distinct[0].id };
  }
  if (matches.length > 1 || scored.some((c) => c.titleOk && !c.artistOk)) {
    return { type: 'review' };
  }
  return { type: 'notfound' };
};

// Runs fn over items with `limit` concurrent workers, preserving input order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const formatCandidates = (candidates) =>
  candidates
    .map((c, i) => {
      const artists = c.artists.join(', ') || '?';
      return `  [${i + 1}] ${c.fullTitle || '?'} - ${artists} (id: ${c.id}) [title ${c.titleOk ? 'OK' : 'NO'} | artist ${c.artistOk ? 'OK' : 'NO'}]`;
    })
    .join('\n');

async function migrate() {
  if (!playlistId) {
    console.error('TIDAL_PLAYLIST_ID is not set in the .env file.');
    process.exit(1);
  }

  if (!fs.existsSync(SOURCE_FILE)) {
    console.log(`No ${SOURCE_FILE} file found. Nothing to migrate.`);
    return;
  }

  const lines = fs
    .readFileSync(SOURCE_FILE, 'utf8')
    .split('\n')
    .map(parseBeatportLine)
    .filter(Boolean);

  if (!lines.length) {
    console.log(`No valid tracks found in ${SOURCE_FILE}`);
    return;
  }

  console.log(`Dry run: ${dryRun ? 'ON' : 'OFF'}`);
  console.log(`Tracks to process: ${lines.length}`);
  console.log('');

  const t0 = Date.now();
  const playlistTrackIds = dryRun ? new Set() : await getPlaylistTrackIds(playlistId);

  const processed = await mapLimit(lines, CONCURRENCY, async ({ name, artist, line }) => {
    const { scored } = await findCandidates(name, artist);
    return { line, ...classify(name, scored), scored };
  });

  const imported = [];
  const notFound = [];
  const review = [];

  for (const r of processed) {
    if (r.type === 'import') imported.push({ line: r.line, id: r.id });
    else if (r.type === 'review') review.push({ line: r.line, candidates: r.scored.slice(0, 5) });
    else notFound.push(r.line);
  }

  for (const r of processed) {
    if (r.type === 'import') console.log(`  [imported]    ${r.line}`);
    else if (r.type === 'review') console.log(`  [needs review] ${r.line}`);
    else console.log(`  [not found]   ${r.line}`);
  }

  console.log('');
  console.log('--- Stats ---');
  console.log(`Total:        ${lines.length}`);
  console.log(`Imported:     ${imported.length}`);
  console.log(`Needs review: ${review.length}`);
  console.log(`Not found:    ${notFound.length}`);
  console.log(`Requests:     ${getRequestCount()}`);
  console.log(`Elapsed:      ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failedSearches > 0) {
    console.log(`Failed searches (skipped): ${failedSearches}`);
  }

  fs.writeFileSync(IMPORTED_FILE, imported.map((i) => i.line).join('\n') + (imported.length ? '\n' : ''));
  fs.writeFileSync(NOT_FOUND_FILE, notFound.join('\n') + (notFound.length ? '\n' : ''));
  const reviewBlocks = review
    .map((r) => `SOURCE: ${r.line}\n${formatCandidates(r.candidates)}`)
    .join('\n');
  fs.writeFileSync(REVIEW_FILE, reviewBlocks + (reviewBlocks ? '\n' : ''));

  console.log(`\nWritten: ${IMPORTED_FILE}, ${REVIEW_FILE}, ${NOT_FOUND_FILE}`);

  if (dryRun) {
    console.log('DRY RUN: playlist and beatport_pending.txt were NOT modified.');
    return;
  }

  const toAdd = imported.filter((i) => !playlistTrackIds.has(String(i.id)));
  const alreadyPresent = imported.length - toAdd.length;
  if (toAdd.length > 0) {
    console.log(`\nAdding ${toAdd.length} track(s) to the Tidal playlist...`);
    const { added } = await addTracksToPlaylist(playlistId, toAdd.map((i) => i.id));
    console.log(`Added ${added} track(s).`);
  } else {
    console.log('\nNo new tracks to add to the playlist.');
  }
  if (alreadyPresent > 0) {
    console.log(`${alreadyPresent} track(s) were already in the playlist.`);
  }

  const importedSet = new Set(imported.map((i) => i.line));
  const remaining = lines.filter((l) => !importedSet.has(l.line)).map((l) => l.line);
  fs.writeFileSync(SOURCE_FILE, remaining.join('\n') + (remaining.length ? '\n' : ''));
  console.log(`Removed ${imported.length} imported track(s) from ${SOURCE_FILE}.`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  migrate().catch((error) => {
    console.error('\nMigration failed:', error.message);
    process.exit(1);
  });
}
