import { LyricsParser } from '../lyrics-parser.js';

/**
 * Normalize text for case-insensitive bilingual (Amharic + Latin) matching.
 * Preserves Ethiopic characters while stripping combining Latin accents and extra spaces.
 * @param {string} value
 * @returns {string}
 */
export function normalizeSearchText(value) {
  if (!value || typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d'".,!?()[\]{}:;/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Search parsed lyrics (or raw plain text fallback) for a matching lyric line.
 * @param {object} track
 * @param {string} normalizedQuery
 * @returns {{ text: string, time: number, lineIndex: number } | null}
 */
export function findMatchingLyricSnippet(track, normalizedQuery) {
  if (!track || !normalizedQuery || typeof track.lyrics !== 'string' || !track.lyrics.trim()) {
    return null;
  }

  const parsed = LyricsParser.parse(track.lyrics);
  if (parsed.length > 0) {
    for (let i = 0; i < parsed.length; i++) {
      const line = parsed[i];
      if (!line.text) continue;
      if (normalizeSearchText(line.text).includes(normalizedQuery)) {
        return {
          text: line.text.trim(),
          time: Number.isFinite(line.time) ? line.time : 0,
          lineIndex: i
        };
      }
    }
    return null;
  }

  const rawLines = track.lyrics.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const clean = rawLines[i].replace(/\[[^\]]*\]/g, '').trim();
    if (!clean) continue;
    if (normalizeSearchText(clean).includes(normalizedQuery)) {
      return { text: clean, time: 0, lineIndex: i };
    }
  }
  return null;
}

/**
 * Score and match tracks across bilingual fields (title, titleEn, artist, artistEn, album, genre)
 * as well as full-text LRC/plain lyrics lines.
 *
 * @param {Array<object>} tracks
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {{
 *   query: string,
 *   normalizedQuery: string,
 *   results: Array<{ track: object, score: number, matchType: string, matchedLyric: { text: string, time: number, lineIndex: number } | null }>,
 *   artists: Array<{ name: string, subtitle: string, count: number, cover: string }>,
 *   albums: Array<{ name: string, artist: string, count: number, cover: string }>
 * }}
 */
export function searchCatalog(tracks, query, options = {}) {
  const list = Array.isArray(tracks) ? tracks : [];
  const rawQuery = String(query || '').trim();
  const normalizedQuery = normalizeSearchText(rawQuery);
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : list.length;

  if (!normalizedQuery) {
    return { query: rawQuery, normalizedQuery: '', results: [], artists: [], albums: [] };
  }

  const terms = normalizedQuery.split(' ').filter(Boolean);
  const scored = [];
  const artistMap = new Map();
  const albumMap = new Map();

  for (const track of list) {
    if (!track) continue;

    const title = normalizeSearchText(track.title);
    const titleEn = normalizeSearchText(track.titleEn);
    const artist = normalizeSearchText(track.artist);
    const artistEn = normalizeSearchText(track.artistEn);
    const album = normalizeSearchText(track.album);
    const genre = normalizeSearchText(track.genre);
    const tags = Array.isArray(track.tags) ? normalizeSearchText(track.tags.join(' ')) : normalizeSearchText(track.tags);

    let score = 0;
    let matchType = '';
    let matchedLyric = null;

    if (title === normalizedQuery || titleEn === normalizedQuery) {
      score = 120;
      matchType = 'title';
    } else if (title.startsWith(normalizedQuery) || titleEn.startsWith(normalizedQuery)) {
      score = 100;
      matchType = 'title';
    } else if (title.includes(normalizedQuery) || titleEn.includes(normalizedQuery)) {
      score = 84;
      matchType = 'title';
    } else if (artist === normalizedQuery || artistEn === normalizedQuery) {
      score = 80;
      matchType = 'artist';
    } else if (artist.includes(normalizedQuery) || artistEn.includes(normalizedQuery)) {
      score = 68;
      matchType = 'artist';
    } else if (album && album.includes(normalizedQuery)) {
      score = 56;
      matchType = 'album';
    } else if ((genre && genre.includes(normalizedQuery)) || (tags && tags.includes(normalizedQuery))) {
      score = 44;
      matchType = 'genre';
    } else if (terms.length > 1) {
      const combined = `${title} ${titleEn} ${artist} ${artistEn} ${album} ${genre} ${tags}`;
      if (terms.every((t) => combined.includes(t))) {
        score = 52;
        matchType = 'title';
      }
    }

    if (score === 0) {
      matchedLyric = findMatchingLyricSnippet(track, normalizedQuery);
      if (matchedLyric) {
        score = 34;
        matchType = 'lyrics';
      }
    }

    if (score > 0) {
      scored.push({ track, score, matchType, matchedLyric });
    }

    if (artist.includes(normalizedQuery) || artistEn.includes(normalizedQuery)) {
      const key = (track.artistEn || track.artist || 'Unknown Artist').trim().toLowerCase();
      if (!artistMap.has(key)) {
        artistMap.set(key, {
          name: track.artist || track.artistEn || 'Unknown Artist',
          subtitle: track.artistEn && track.artistEn !== track.artist ? track.artistEn : '',
          count: 0,
          cover: track.cover || ''
        });
      }
      const entry = artistMap.get(key);
      entry.count += 1;
      if (!entry.cover && track.cover) entry.cover = track.cover;
    }

    if (album && album !== 'single' && album.includes(normalizedQuery)) {
      const key = `${(track.album || '').trim().toLowerCase()}__${(track.artist || '').trim().toLowerCase()}`;
      if (!albumMap.has(key)) {
        albumMap.set(key, {
          name: track.album,
          artist: track.artist || track.artistEn || '',
          count: 0,
          cover: track.cover || ''
        });
      }
      const entry = albumMap.get(key);
      entry.count += 1;
      if (!entry.cover && track.cover) entry.cover = track.cover;
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.track.title || '').localeCompare(b.track.title || '');
  });

  const artists = Array.from(artistMap.values()).sort((a, b) => b.count - a.count).slice(0, 6);
  const albums = Array.from(albumMap.values()).sort((a, b) => b.count - a.count).slice(0, 6);

  return {
    query: rawQuery,
    normalizedQuery,
    results: scored.slice(0, limit),
    artists,
    albums
  };
}
