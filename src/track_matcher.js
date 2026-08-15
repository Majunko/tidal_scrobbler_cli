import Fuse from 'fuse.js';

/**
 * Remove diacritics (accents, eg: Fēlēs) from a string
 *  */
const removeDiacritics = (str) => {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Normalize brackets/parentheses in titles (e.g. '(' → '[' and ')' → ']')
 */
export const normalize = (title = '') => String(title).replace(/[\[\(]/g, '[').replace(/[\]\)]/g, ']');

// Normalize artist string: split by comma/ampersand, trim, sort, join
export const normalizeArtist = (artist) => {
  if (!artist) return '';
  // Replace ' & ' and ',' with a common separator, then split
  return artist
    .replace(/(\s*&\s*|,\s*)/g, ',') // unify separators: "A & B, C" → "A,B,C"
    .split(',')
    .map(a => removeDiacritics(a.trim().toLowerCase()))
    .sort()
    .join(',');
}

const normalizeArtistSet = (artist) => {
  if (!artist) return new Set();

  const artistString = Array.isArray(artist)
    ? artist.join(', ')
    : String(artist);

  return new Set(
    artistString
      .replace(/(\s*&\s*|,\s*)/g, ',')
      .split(',')
      .map(a => removeDiacritics(a.trim().toLowerCase()))
      .filter(Boolean)
  );
}

const isSubset = (aSet, bSet) => {
  if (aSet.size === 0) return false;
  for (const v of aSet) {
    if (!bSet.has(v)) return false;
  }
  return true;
}

const isArtistSetMatch = (aSet, bSet) => {
  if (aSet.size === 0 || bSet.size === 0) return false;

  if (aSet.size === bSet.size) {
    return isSubset(aSet, bSet);
  }

  return isSubset(aSet, bSet) || isSubset(bSet, aSet);
}

// Precompute the title variants used for matching (mirrors the original
// isFuzzyTitleMatch checks): raw, bracket/parenthesis normalized, and
// diacritics removed.
const titleVariants = (title) => {
  const t = String(title ?? '');
  return {
    raw: t,
    bracketNorm: normalize(t),
    noDiac: removeDiacritics(t),
  };
}

// Return the songs i've already listened to.
// Optimized: precomputes title indexes (exact matches are O(1) lookups) and
// builds a single Fuse index, instead of the previous O(N*M) scan that created
// a Fuse instance for every title comparison.
export const compareSongsAlreadyListened = (tidalSongs, dbSongs) => {
  if (!dbSongs.length) return [];

  const buildEntry = (song) => {
    const variants = titleVariants(song.name);
    return {
      ...variants,
      artists: normalizeArtistSet(song.artist),
    };
  };

  const dbEntries = dbSongs.map(buildEntry);

  const buildIndex = (keyFn) => {
    const map = new Map();
    for (const entry of dbEntries) {
      const key = keyFn(entry);
      const list = map.get(key) || [];
      list.push(entry);
      map.set(key, list);
    }
    return map;
  };

  const rawIndex = buildIndex((e) => e.raw);
  const bracketIndex = buildIndex((e) => e.bracketNorm);
  const noDiacIndex = buildIndex((e) => e.noDiac);

  // Inverted artist index: normalized artist name -> DB entries. A track can
  // only match if it shares at least one artist with a DB entry, so this lets
  // us skip the expensive fuzzy search entirely when there is no overlap.
  const artistIndex = new Map();
  for (const entry of dbEntries) {
    for (const artist of entry.artists) {
      const list = artistIndex.get(artist) || [];
      list.push(entry);
      artistIndex.set(artist, list);
    }
  }

  // Lazy per-artist Fuse index over that artist's unique short DB titles.
  // Fuzzy matching only applies to reasonably short titles (mirroring the
  // original behavior), and the result set is per-title independent, so
  // searching per-artist indexes is equivalent to searching one big index.
  const artistFuseCache = new Map();
  const getArtistFuse = (artist) => {
    if (artistFuseCache.has(artist)) return artistFuseCache.get(artist);
    const entries = artistIndex.get(artist);
    let fuse = null;
    if (entries) {
      const titles = [
        ...new Set(entries.filter((e) => e.raw.length < 50).map((e) => e.noDiac)),
      ];
      if (titles.length) {
        fuse = new Fuse(titles, {
          includeScore: true,
          threshold: 0.05, // 95% similarity - extremely strict
        });
      }
    }
    artistFuseCache.set(artist, fuse);
    return fuse;
  };

  const matchesIn = (list, artistSet) => {
    if (!list) return false;
    for (const entry of list) {
      if (isArtistSetMatch(artistSet, entry.artists)) return true;
    }
    return false;
  };

  return tidalSongs.filter((tidalSong) => {
    const entry = buildEntry(tidalSong);
    const artistSet = entry.artists;
    if (artistSet.size === 0) return false;

    // Exact matches (raw, bracket-normalized, diacritics-removed)
    if (matchesIn(rawIndex.get(entry.raw), artistSet)) return true;
    if (matchesIn(bracketIndex.get(entry.bracketNorm), artistSet)) return true;
    if (matchesIn(noDiacIndex.get(entry.noDiac), artistSet)) return true;

    // Fuzzy fallback for reasonably short titles
    if (entry.raw.length >= 50) return false;

    // Skip fuzzy matching when no DB entry shares any artist.
    const overlappingEntries = [];
    for (const artist of artistSet) {
      const list = artistIndex.get(artist);
      if (list) overlappingEntries.push(...list);
    }
    if (!overlappingEntries.length) return false;

    // Deduplicate matched titles across the artist indexes.
    const matchedTitles = new Set();
    for (const artist of artistSet) {
      const fuse = getArtistFuse(artist);
      if (!fuse) continue;
      for (const result of fuse.search(entry.noDiac)) {
        matchedTitles.add(result.item);
      }
    }

    for (const title of matchedTitles) {
      if (matchesIn(noDiacIndex.get(title), artistSet)) return true;
    }

    return false;
  });
}

/**
 * Returns only the duplicate tracks
 */
export const findDuplicateTracks = (tracks) => {
  const seen = new Map(); // Stores composite keys we've encountered
  const duplicates = []; // Stores the actual duplicate objects

  const normalizeTitleForKey = (title = '') =>
    normalize(removeDiacritics(String(title)))
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  for (const track of tracks) {
    // Normalize title and artist to create a robust key
    const titleKey = normalizeTitleForKey(track.name);

    // Ensure artist is a string; if array, join with comma
    const artistRaw = Array.isArray(track.artist) ? track.artist.join(', ') : (track.artist || '');
    const artistKey = normalizeArtist(artistRaw);

    const key = `${titleKey}|${artistKey}`;

    if (seen.has(key)) {
      duplicates.push(track); // Found a duplicate
    } else {
      seen.set(key, true); // Mark this combination as seen
    }
  }

  return duplicates;
}
