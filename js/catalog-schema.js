/**
 * Normalized Mezmur Catalog Schema & Grouping Utilities
 *
 * Classifies and groups Mezmurs into structured Zemari/Choir and Collection/Album entities,
 * supporting both explicit Firestore entity records and derived metadata
 * from legacy/local Mezmurs (including Amharic/Ge'ez Ethiopic Fidel & English names),
 * plus rich liturgical & devotional attributes for discovery and recommendations.
 */

export const HYMN_CATEGORIES = [
  'Misgana (Praise & Thanksgiving)',
  'Tselot & Limena (Prayer & Supplication)',
  'Nisiha (Repentance & Mercy)',
  "Be'alat (Feast & Holiday)",
  'Mariam (Kidist Dingil)',
  'Medhane Alem & Meskel',
  'Qiddusan & Melaekt (Saints & Angels)',
  'Werib & Mahlet (Liturgical Chant)',
  'Kidassie & Zema (Liturgy)',
  'Wedding / Serg (የሠርግ)',
  'Sunday School / Kids (የሕጻናት)',
  'Instrumental / Begena',
  'Other'
];

// Backwards-compatible alias for any callers referencing GENRE_CATEGORIES
export const GENRE_CATEGORIES = HYMN_CATEGORIES;

export const LITURGICAL_SEASONS = [
  'Year-Round (ዘወትር)',
  'Abiy Tsom / Great Lent (ዐቢይ ጾም)',
  'Himamat / Holy Week (ሕማማት)',
  'Tinsae / Easter (ትንሣኤ)',
  'Zemene Tsige (ዘመነ ጽጌ)',
  'Kiremt (ክረምት)',
  'Filseta (ፍልሰታ)',
  'Meskel (መስቀል)',
  'Gena / Lideta (ገና)',
  'Timket (ጥምቀት)',
  'Enkutatash (ዘመን መለወጫ)',
  'Tsome Nebiyat (Advent)'
];

export const ZEMA_MODES = [
  "Ge'ez (ግዕዝ)",
  'Ezel (ዕዝል)',
  'Araray (አራራይ)',
  'Begena / Traditional',
  'Tizita',
  'Bati',
  'Ambassel',
  'Anchihoye',
  'Modern Choir / Studio'
];

export const VOCAL_STYLES = [
  'Solo Zemari (ነጠላ ዘማሪ)',
  'Choir / Zemariyan (መዘምራን)',
  'Duet / Group',
  'Male Vocal',
  'Female Vocal',
  'Congregational / A Cappella'
];

export const MEZMUR_LANGUAGES = [
  'Amharic (አማርኛ)',
  "Ge'ez (ግዕዝ)",
  "Amharic & Ge'ez",
  'Afaan Oromo',
  'Tigrigna (ትግርኛ)',
  'Other Ethiopian Regional',
  'Multilingual / English'
];

export const DEVOTIONAL_MOODS = [
  'Reverent & Contemplative (ተመስጦ)',
  'Joyful & Festive (ደስታና ምስጋና)',
  'Sorrowful & Lenten (ሐዘንና ንስሐ)',
  'Comforting & Peaceful (መጽናናት)',
  'Solemn Intercession (ምልጃ)'
];

export const MEZMUR_ERAS = [
  'Classical / Traditional (ቀደምት)',
  'Contemporary (ዘመናዊ)'
];

const DEFAULT_COVER = 'brand/elm-default-cover.svg';

/**
 * Normalize comma-separated or array tags into a clean deduplicated string array.
 */
export function normalizeTags(rawTags) {
  const parts = Array.isArray(rawTags)
    ? rawTags
    : String(rawTags || '').split(/[,;|]+/);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const clean = String(part || '').trim();
    const key = clean.toLowerCase();
    if (clean && !seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  }
  return out;
}

/**
 * Normalize an external streaming/listening URL (HTTP/HTTPS only).
 */
export function normalizeExternalUrl(rawUrl) {
  const clean = String(rawUrl || '').trim();
  if (!clean) return '';
  return /^https?:\/\//i.test(clean) ? clean : '';
}

/**
 * Create a stable, URL-safe ID slug from Amharic or Latin text.
 * Preserves Ethiopic Unicode characters (\u1200-\u137F) or falls back to a short hash
 * so distinct Amharic names never collapse to the same empty slug.
 */
export function slugifyId(text, fallbackPrefix = 'item') {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return `${fallbackPrefix}_unknown`;

  const cleaned = raw
    .normalize('NFKC')
    .replace(/['"`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

  if (cleaned) return cleaned;

  // Deterministic FNV-1a hash fallback
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${fallbackPrefix}_${(hash >>> 0).toString(36)}`;
}

export function makeArtistId(artistName, artistEn = '') {
  const base = (artistEn && artistEn.trim()) || (artistName && artistName.trim()) || '';
  const low = base.toLowerCase();
  if (!base || low === 'unknown artist' || low === 'unknown zemari') return 'art_unknown';
  return `art_${slugifyId(base, 'art')}`;
}

export function isSingleAlbumName(albumName) {
  const clean = String(albumName || '').trim().toLowerCase();
  return !clean || clean === 'single' || clean === 'singles' || clean === 'my album';
}

export function makeAlbumId(artistId, albumTitle) {
  const aId = artistId || 'art_unknown';
  if (isSingleAlbumName(albumTitle)) {
    return `alb_${aId}_single`;
  }
  return `alb_${aId}_${slugifyId(albumTitle, 'alb')}`;
}

function isCustomCover(cover) {
  return !!(cover && cover !== DEFAULT_COVER && !cover.endsWith('/elm-default-cover.svg'));
}

export class CatalogSchema {
  /**
   * Normalize a raw track object into a consistent schema shape without mutating the original.
   */
  static normalizeTrack(track) {
    if (!track) return null;
    const artist = (track.artist || 'Unknown Zemari').trim();
    const artistEn = (track.artistEn || artist).trim();
    const album = (track.album || 'Single').trim() || 'Single';
    const artistId = track.artistId || makeArtistId(artist, artistEn);
    const albumId = track.albumId || makeAlbumId(artistId, album);
    const trackNumber = Number.isFinite(Number(track.trackNumber)) && Number(track.trackNumber) > 0
      ? Number(track.trackNumber)
      : null;
    const hymnCategory = (track.hymnCategory || track.genre || '').trim();
    const genre = (track.genre || hymnCategory || '').trim();

    return {
      ...track,
      title: (track.title || 'Untitled').trim(),
      titleEn: (track.titleEn || track.title || 'Untitled').trim(),
      artist,
      artistEn,
      artistId,
      album,
      albumId,
      genre,
      hymnCategory,
      liturgicalSeason: (track.liturgicalSeason || '').trim(),
      feastOrDedication: (track.feastOrDedication || '').trim(),
      zemaMode: (track.zemaMode || '').trim(),
      vocalStyle: (track.vocalStyle || '').trim(),
      language: (track.language || '').trim(),
      devotionalMood: (track.devotionalMood || '').trim(),
      era: (track.era || '').trim(),
      composer: (track.composer || '').trim(),
      scriptureReference: (track.scriptureReference || '').trim(),
      churchDebir: (track.churchDebir || '').trim(),
      externalUrl: normalizeExternalUrl(track.externalUrl),
      tags: normalizeTags(track.tags),
      trackNumber,
      year: track.year ? String(track.year).trim() : '',
      cover: track.cover || DEFAULT_COVER
    };
  }

  /**
   * Build a unified, relational index of Artists -> Albums -> Tracks
   * by merging optional Firestore artist/album records with all tracks.
   */
  static buildCatalogIndex(tracks = [], firestoreArtists = [], firestoreAlbums = []) {
    const artistMap = new Map();
    const albumMap = new Map();

    // 1. Seed from explicit Firestore artist records
    for (const a of (firestoreArtists || [])) {
      if (!a || !a.id) continue;
      artistMap.set(a.id, {
        id: a.id,
        name: (a.name || a.nameEn || 'Unknown Zemari').trim(),
        nameEn: (a.nameEn || a.name || '').trim(),
        cover: a.cover || DEFAULT_COVER,
        genres: new Set(Array.isArray(a.genres) ? a.genres.filter(Boolean) : []),
        tracks: [],
        albumIds: new Set()
      });
    }

    // 2. Seed from explicit Firestore album records
    for (const alb of (firestoreAlbums || [])) {
      if (!alb || !alb.id) continue;
      const artistId = alb.artistId || makeArtistId(alb.artistName || alb.artist || '');
      albumMap.set(alb.id, {
        id: alb.id,
        title: (alb.title || 'Single').trim(),
        artistId,
        artistName: (alb.artistName || alb.artist || 'Unknown Zemari').trim(),
        year: alb.year ? String(alb.year).trim() : '',
        cover: alb.cover || DEFAULT_COVER,
        genre: (alb.genre || '').trim(),
        isSingle: Boolean(alb.isSingle) || isSingleAlbumName(alb.title),
        tracks: []
      });
    }

    // 3. Group all tracks into Artists and Albums
    const normalizedTracks = [];
    for (const raw of (tracks || [])) {
      const t = this.normalizeTrack(raw);
      if (!t) continue;
      normalizedTracks.push(t);

      // Ensure Artist entry exists
      let artist = artistMap.get(t.artistId);
      if (!artist) {
        artist = {
          id: t.artistId,
          name: t.artist,
          nameEn: t.artistEn,
          cover: t.cover,
          genres: new Set(),
          tracks: [],
          albumIds: new Set()
        };
        artistMap.set(t.artistId, artist);
      } else {
        if (!isCustomCover(artist.cover) && isCustomCover(t.cover)) {
          artist.cover = t.cover;
        }
        if ((!artist.nameEn || artist.nameEn === artist.name) && t.artistEn && t.artistEn !== t.artist) {
          artist.nameEn = t.artistEn;
        }
      }
      if (t.genre) artist.genres.add(t.genre);
      artist.tracks.push(t);
      artist.albumIds.add(t.albumId);

      // Ensure Album entry exists
      let album = albumMap.get(t.albumId);
      if (!album) {
        album = {
          id: t.albumId,
          title: t.album,
          artistId: t.artistId,
          artistName: artist.name,
          year: t.year || '',
          cover: t.cover,
          genre: t.genre || '',
          isSingle: isSingleAlbumName(t.album),
          tracks: []
        };
        albumMap.set(t.albumId, album);
      } else {
        if (!isCustomCover(album.cover) && isCustomCover(t.cover)) {
          album.cover = t.cover;
        }
        if (!album.year && t.year) album.year = t.year;
        if (!album.genre && t.genre) album.genre = t.genre;
      }
      album.tracks.push(t);
    }

    // 4. Finalize Artist & Album summaries and sort tracks inside albums
    const albums = Array.from(albumMap.values())
      .filter(alb => alb.tracks.length > 0)
      .map(alb => {
        alb.tracks.sort((a, b) => {
          const an = a.trackNumber ?? Number.MAX_SAFE_INTEGER;
          const bn = b.trackNumber ?? Number.MAX_SAFE_INTEGER;
          if (an !== bn) return an - bn;
          return (a.title || '').localeCompare(b.title || '');
        });
        return {
          ...alb,
          trackCount: alb.tracks.length
        };
      })
      .sort((a, b) => {
        if (a.isSingle !== b.isSingle) return a.isSingle ? 1 : -1;
        return (a.title || '').localeCompare(b.title || '');
      });

    const artists = Array.from(artistMap.values())
      .filter(art => art.tracks.length > 0)
      .map(art => {
        const artistAlbums = albums.filter(alb => alb.artistId === art.id);
        return {
          id: art.id,
          name: art.name,
          nameEn: art.nameEn,
          cover: art.cover,
          genres: Array.from(art.genres),
          tracks: art.tracks,
          trackCount: art.tracks.length,
          albums: artistAlbums,
          albumCount: artistAlbums.filter(a => !a.isSingle).length
        };
      })
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Re-index finalized objects for O(1) lookup
    const finalArtistMap = new Map(artists.map(a => [a.id, a]));
    const finalAlbumMap = new Map(albums.map(a => [a.id, a]));

    return {
      artists,
      albums,
      tracks: normalizedTracks,
      artistMap: finalArtistMap,
      albumMap: finalAlbumMap,
      getArtist: (id) => finalArtistMap.get(id) || null,
      getAlbum: (id) => finalAlbumMap.get(id) || null,
      getAlbumsByArtist: (artistId) => albums.filter(a => a.artistId === artistId),
      getTracksByArtist: (artistId) => finalArtistMap.get(artistId)?.tracks || [],
      getTracksByAlbum: (albumId) => finalAlbumMap.get(albumId)?.tracks || []
    };
  }
}
