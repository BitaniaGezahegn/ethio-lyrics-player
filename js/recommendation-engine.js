/**
 * RecommendationEngine - Intelligent Ethiopian Mezmur Discovery & Recommendation System
 *
 * Features:
 * 1. Multi-factor affinity scoring (Zemari affinity, hymnCategory, liturgicalSeason, zemaMode, vocalStyle, tags, LRC richness)
 * 2. Time-of-day devotional context (Morning Praise, Midday Reflection, Evening Vespers, Night Vigil)
 * 3. Liturgical & Zema classification (Misgana, Nisiha, Mariam, Begena, Ge'ez, Ezel, Araray)
 * 4. Context-aware "Related Mezmurs / Because You Listened" similarity matching
 * 5. Quick Resume / Continue Listening shelf generation
 * 6. Zemari & Choir discovery grouping
 */

export class RecommendationEngine {
  static _metaCache = new WeakMap();

  static _buildTrackIndex(allTracks) {
    const map = new Map();
    for (let i = 0; i < allTracks.length; i++) {
      const t = allTracks[i];
      if (t && t.id && !map.has(t.id)) {
        map.set(t.id, t);
      }
    }
    return map;
  }

  /**
   * Determine time-of-day devotional greeting and Mezmur context
   */
  static getGreetingData(userName = '') {
    const now = new Date();
    const hour = now.getHours();
    const displayName = userName && userName !== 'Music Lover' && userName !== 'Beloved Listener' ? userName : '';

    if (hour >= 5 && hour < 12) {
      return {
        period: 'morning',
        greetingAm: 'እንደምን አደሩ',
        greetingEn: displayName ? `Blessed morning, ${displayName}` : 'Blessed morning',
        moodTag: 'Morning Praise',
        moodTagAm: 'የማለዳ ምስጋና',
        moodSubtitle: 'Thanksgiving and morning Mezmurs to lift your spirit at dawn',
        accentColor: '#f59e0b'
      };
    } else if (hour >= 12 && hour < 17) {
      return {
        period: 'afternoon',
        greetingAm: 'እንደምን ዋሉ',
        greetingEn: displayName ? `Blessed afternoon, ${displayName}` : 'Blessed afternoon',
        moodTag: 'Midday Praise',
        moodTagAm: 'የቀትር ውዳሴ',
        moodSubtitle: 'Joyful choir hymns and synchronized spiritual reflections',
        accentColor: '#3b82f6'
      };
    } else if (hour >= 17 && hour < 22) {
      return {
        period: 'evening',
        greetingAm: 'እንደምን አመሹ',
        greetingEn: displayName ? `Blessed evening, ${displayName}` : 'Blessed evening',
        moodTag: 'Evening Vespers',
        moodTagAm: 'የሠርክ ጸሎት',
        moodSubtitle: 'Contemplative evening Mezmurs, Begena hymns, and quiet prayer',
        accentColor: '#ec4899'
      };
    } else {
      return {
        period: 'night',
        greetingAm: 'ደህና እደሩ',
        greetingEn: displayName ? `Peaceful Night, ${displayName}` : 'Peaceful Night',
        moodTag: 'Night Vigil',
        moodTagAm: 'የሌሊት ዝማሬ',
        moodSubtitle: 'Soothing night-watch Mezmurs, repentance hymns, and peaceful zema',
        accentColor: '#8b5cf6'
      };
    }
  }

  /**
   * Quick resume / Jump Back In tracks (Spotify-style quick launch pad)
   */
  static getJumpBackIn(allTracks, recentlyPlayedIds = [], favoriteIds = [], limit = 6) {
    if (!allTracks || allTracks.length === 0) return [];
    const trackMap = this._buildTrackIndex(allTracks);
    const pool = [];
    const seenIds = new Set();

    // 1. Add recent tracks first
    (recentlyPlayedIds || []).forEach(id => {
      const match = trackMap.get(id);
      if (match && !seenIds.has(match.id)) {
        pool.push(match);
        seenIds.add(match.id);
      }
    });

    // 2. Supplement with favorites if recent is less than limit
    if (pool.length < limit) {
      (favoriteIds || []).forEach(id => {
        const match = trackMap.get(id);
        if (match && !seenIds.has(match.id)) {
          pool.push(match);
          seenIds.add(match.id);
        }
      });
    }

    // 3. Fallback to catalog tracks with rich lyrics if still less than limit
    if (pool.length < limit) {
      for (let i = 0; i < allTracks.length && pool.length < limit; i++) {
        const t = allTracks[i];
        if (!seenIds.has(t.id)) {
          pool.push(t);
          seenIds.add(t.id);
        }
      }
    }

    return pool.slice(0, limit);
  }

  /**
   * Accumulate affinity profiles across rich hymn metadata from recently played, favorites, and current Mezmur
   */
  static _buildUserAffinityProfile(allTracks, { favorites = [], recentlyPlayed = [], currentTrack = null } = {}) {
    const trackMap = this._buildTrackIndex(allTracks);
    const artistScores = {};
    const categoryScores = {};
    const seasonScores = {};
    const zemaScores = {};
    const vocalScores = {};
    const tagScores = {};

    const bump = (map, key, weight) => {
      const k = String(key || '').trim().toLowerCase();
      if (!k) return;
      map[k] = (map[k] || 0) + weight;
    };

    const applyTrack = (tr, weight) => {
      if (!tr) return;
      if (tr.artist) bump(artistScores, tr.artist, weight);
      bump(categoryScores, tr.hymnCategory || tr.genre, weight);
      bump(seasonScores, tr.liturgicalSeason, weight);
      bump(zemaScores, tr.zemaMode, weight);
      bump(vocalScores, tr.vocalStyle, weight * 0.7);
      const tags = Array.isArray(tr.tags)
        ? tr.tags
        : String(tr.tags || '').split(/[,;|]+/).map(s => s.trim()).filter(Boolean);
      tags.forEach(tag => bump(tagScores, tag, weight * 0.6));
    };

    (recentlyPlayed || []).forEach((id, idx) => {
      const tr = trackMap.get(id);
      const recencyMultiplier = Math.max(1, 5 - idx * 0.5);
      applyTrack(tr, 3 * recencyMultiplier);
    });

    (favorites || []).forEach(id => {
      applyTrack(trackMap.get(id), 6);
    });

    if (currentTrack) applyTrack(currentTrack, 4);

    return { artistScores, categoryScores, seasonScores, zemaScores, vocalScores, tagScores };
  }

  /**
   * Multi-factor scoring recommendation engine ("Chosen For You")
   */
  static getPersonalizedRecommendations(allTracks, {
    favorites = [],
    recentlyPlayed = [],
    currentTrack = null,
    activeVibe = 'all',
    limit = 10
  } = {}) {
    if (!allTracks || allTracks.length === 0) return [];

    const favSet = new Set(favorites || []);
    const recentSet = new Set(recentlyPlayed || []);
    const recentList = recentlyPlayed || [];

    const {
      artistScores,
      categoryScores,
      seasonScores,
      zemaScores,
      vocalScores,
      tagScores
    } = this._buildUserAffinityProfile(allTracks, { favorites, recentlyPlayed, currentTrack });

    const hour = new Date().getHours();
    const isEveningOrNight = hour >= 18 || hour < 6;

    // Score and filter each Mezmur
    const scored = allTracks.map(track => {
      let score = 0;
      const meta = this.parseFallbackMetadata(track);
      const artistName = (meta.artist || '').toLowerCase();

      // 1. Synchronized Lyrics Richness (+14 pts)
      if (track.lrc && typeof track.lrc === 'string' && track.lrc.length > 25) {
        score += 14;
        if (track.lrc.length > 150) score += 4;
      }

      // 2. Zemari / Choir Affinity
      if (artistName && artistScores[artistName]) {
        score += Math.min(20, artistScores[artistName]);
      }

      // 3. Hymn Category, Liturgical Season, Zema Mode & Vocal Style Affinity
      const catKey = String(track.hymnCategory || track.genre || '').trim().toLowerCase();
      if (catKey && categoryScores[catKey]) {
        score += Math.min(18, categoryScores[catKey] * 1.1);
      }
      const seasonKey = String(track.liturgicalSeason || '').trim().toLowerCase();
      if (seasonKey && seasonScores[seasonKey] && !seasonKey.includes('year-round')) {
        score += Math.min(14, seasonScores[seasonKey]);
      }
      const zemaKey = String(track.zemaMode || '').trim().toLowerCase();
      if (zemaKey && zemaScores[zemaKey]) {
        score += Math.min(10, zemaScores[zemaKey] * 0.9);
      }
      const vocalKey = String(track.vocalStyle || '').trim().toLowerCase();
      if (vocalKey && vocalScores[vocalKey]) {
        score += Math.min(8, vocalScores[vocalKey]);
      }
      const trackTags = Array.isArray(track.tags) ? track.tags : [];
      for (const tg of trackTags) {
        const k = String(tg || '').trim().toLowerCase();
        if (k && tagScores[k]) {
          score += Math.min(8, tagScores[k] * 0.5);
          break;
        }
      }

      // 4. User Engagement (Favorites & Offline Downloads)
      if (favSet.has(track.id)) score += 10;
      if (track.isDownloaded || track.audioBlob) score += 5;

      // 5. Authentic Ethiopic Fidel presence bonus
      if (meta.hasEthiopic) score += 3;

      // 6. Anti-Fatigue: Slight reduction if currently playing or last played
      if (currentTrack && currentTrack.id === track.id) {
        score -= 8;
      } else if (recentList.length > 0 && recentList[0] === track.id) {
        score -= 4;
      }

      // 7. Devotional Time-of-Day Alignment
      const combinedCtx = `${catKey} ${zemaKey} ${String(track.devotionalMood || '').toLowerCase()} ${meta.vibe}`;
      if (isEveningOrNight) {
        if (/nisiha|tselot|begena|reverent|sorrow|comfort|solemn|ge'ez|ezel|tizita|night|vespers/.test(combinedCtx)) {
          score += 7;
        }
      } else {
        if (/misgana|joyful|be'alat|choir|tinsae|araray|festive|morning/.test(combinedCtx)) {
          score += 6;
        }
      }

      // 8. Cold-Start Exploration & Gentle Refresh Jitter
      if (!recentSet.has(track.id) && !favSet.has(track.id)) score += 3.5;
      score += (Math.random() * 5) - 2.5;

      return { track, score };
    });

    // Optional category/era filter compatibility
    let filtered = scored;
    if (activeVibe === 'lrc') {
      filtered = filtered.filter(item => item.track.lrc && item.track.lrc.length > 15);
    } else if (activeVibe === 'classic') {
      filtered = filtered.filter(item => {
        const t = item.track;
        return (t.era && /classical|traditional/i.test(t.era)) ||
          (t.year && parseInt(t.year, 10) < 2010);
      });
    } else if (activeVibe === 'favorites') {
      filtered = filtered.filter(item => favSet.has(item.track.id));
    } else if (activeVibe === 'recent') {
      filtered = filtered.filter(item => recentSet.has(item.track.id));
    }

    filtered.sort((a, b) => b.score - a.score);
    return filtered.map(item => item.track).slice(0, limit);
  }

  /**
   * "Because You Listened To [Zemari]" Seed Shelf
   * Matches shared Zemari, hymn category, liturgical season, feast, or Zema mode
   */
  static getBecauseYouListenedShelf(allTracks, { recentlyPlayed = [], favorites = [], currentTrack = null } = {}) {
    if (!allTracks || allTracks.length < 2) return null;
    const trackMap = this._buildTrackIndex(allTracks);

    let seedTrack = currentTrack;
    if (!seedTrack && recentlyPlayed.length > 0) seedTrack = trackMap.get(recentlyPlayed[0]);
    if (!seedTrack && favorites.length > 0) seedTrack = trackMap.get(favorites[0]);
    if (!seedTrack) seedTrack = allTracks[0];
    if (!seedTrack) return null;

    const seedArtist = seedTrack.artist;
    const seedId = seedTrack.id;
    const seedCat = (seedTrack.hymnCategory || seedTrack.genre || '').toLowerCase();
    const seedSeason = (seedTrack.liturgicalSeason || '').toLowerCase();
    const seedZema = (seedTrack.zemaMode || '').toLowerCase();

    const ranked = allTracks
      .filter(t => t.id !== seedId)
      .map(t => {
        let sim = 0;
        if (seedArtist && t.artist === seedArtist) sim += 30;
        const cat = (t.hymnCategory || t.genre || '').toLowerCase();
        if (seedCat && cat && cat === seedCat) sim += 20;
        const season = (t.liturgicalSeason || '').toLowerCase();
        if (seedSeason && season && season === seedSeason && !season.includes('year-round')) sim += 16;
        const zema = (t.zemaMode || '').toLowerCase();
        if (seedZema && zema && zema === seedZema) sim += 12;
        if (seedTrack.feastOrDedication && t.feastOrDedication &&
          t.feastOrDedication.toLowerCase() === seedTrack.feastOrDedication.toLowerCase()) {
          sim += 18;
        }
        return { t, sim };
      })
      .filter(item => item.sim > 0)
      .sort((a, b) => b.sim - a.sim)
      .map(item => item.t);

    if (ranked.length === 0) return null;

    const subtitleDetail = seedTrack.hymnCategory || seedTrack.zemaMode || seedTrack.liturgicalSeason;
    return {
      seedTrack,
      seedArtist,
      title: `Because You Listened To ${seedArtist}`,
      titleAm: `${seedArtist}ን ስላደመጡ የተመረጡ`,
      subtitle: subtitleDetail
        ? `Mezmurs sharing this ${subtitleDetail} theme and spiritual tone`
        : `More Mezmurs in a similar devotional spirit to "${seedTrack.title}"`,
      tracks: ranked.slice(0, 8)
    };
  }

  /**
   * Showcase of Mezmurs with rich synchronized lyrics
   */
  static getLyricsStageShowcase(allTracks, limit = 8) {
    if (!allTracks) return [];
    return allTracks
      .filter(t => t.lrc && typeof t.lrc === 'string' && t.lrc.length > 30)
      .sort((a, b) => (b.lrc.length || 0) - (a.lrc.length || 0))
      .slice(0, limit);
  }

  /**
   * Parse fallback metadata from title, filename, or raw string when tags are missing
   */
  static parseFallbackMetadata(track) {
    if (!track) return { title: 'Untitled', artist: 'Unknown Zemari', hasEthiopic: false, vibe: 'general' };

    const cached = this._metaCache.get(track);
    if (cached && cached._title === track.title && cached._artist === track.artist && cached._lrcLen === (track.lrc ? track.lrc.length : 0)) {
      return cached.result;
    }

    let title = (track.title || '').trim();
    let artist = (track.artist || '').trim();

    if ((!artist || artist.toLowerCase() === 'unknown artist' || artist.toLowerCase() === 'unknown zemari') && title) {
      if (title.includes(' - ')) {
        const parts = title.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      } else if (title.includes(' — ')) {
        const parts = title.split(' — ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' — ').trim();
      } else if (title.includes('_') && !title.includes(' ')) {
        const parts = title.split('_');
        if (parts.length >= 2) {
          artist = parts[0].trim();
          title = parts.slice(1).join(' ').trim();
        }
      }
    }

    title = title.replace(/\.(mp3|m4a|wav|aac|flac|ogg)$/i, '').trim();

    const hasEthiopic = /[\u1200-\u137F]/.test(title + ' ' + artist + ' ' + (track.lrc || ''));
    const vibe = this.detectEthioVibe(track, title);

    const result = {
      title: title || 'Untitled Mezmur',
      artist: artist || 'Mezmur Zemari',
      hasEthiopic,
      vibe
    };

    if (typeof track === 'object') {
      this._metaCache.set(track, {
        _title: track.title,
        _artist: track.artist,
        _lrcLen: track.lrc ? track.lrc.length : 0,
        result
      });
    }
    return result;
  }

  /**
   * Detect Mezmur liturgical/musical context from text and metadata clues
   */
  static detectEthioVibe(track, cleanTitle = '') {
    const combined = `${cleanTitle} ${track.title || ''} ${track.artist || ''} ${track.album || ''} ${track.hymnCategory || track.genre || ''} ${track.zemaMode || ''} ${track.liturgicalSeason || ''}`.toLowerCase();

    if (/misgana|praise|ምስጋና|ውዳሴ/i.test(combined)) return 'misgana';
    if (/nisiha|repent|ንስሐ|ይቅርታ/i.test(combined)) return 'nisiha';
    if (/mariam|dingil|ማርያም|ድንግል|ኪዳነ/i.test(combined)) return 'mariam';
    if (/begena|በገና/i.test(combined)) return 'begena';
    if (/ge'ez|geez|ግዕዝ|mahlet|werib/i.test(combined)) return 'geez';
    if (/ezel|ዕዝል/i.test(combined)) return 'ezel';
    if (/araray|አራራይ/i.test(combined)) return 'araray';
    if (/tizita|tezita|ትዝታ/i.test(combined)) return 'tizita';
    if (/bati|ባቲ/i.test(combined)) return 'bati';
    if (/ambassel|ambasel|አምባሰል/i.test(combined)) return 'ambassel';
    if (/anchihoye|አንቺሆዬ/i.test(combined)) return 'anchihoye';
    if (/oromo|oromiffa|ኦሮሞ/i.test(combined)) return 'oromo';
    if (/tigrigna|ትግርኛ/i.test(combined)) return 'tigrigna';

    if (track.duration && track.duration > 320) return 'contemplative';
    return 'general';
  }

  /**
   * Extract iconic Ethiopian artists represented in the catalog
   */
  static getIconicArtists(allTracks) {
    if (!allTracks || allTracks.length === 0) return [];
    const artistMap = {};

    allTracks.forEach(track => {
      const parsed = this.parseFallbackMetadata(track);
      const artist = parsed.artist;
      if (!artistMap[artist]) {
        artistMap[artist] = {
          name: artist,
          cover: track.cover || 'brand/elm-default-cover.svg',
          trackCount: 0,
          sampleTrack: track
        };
      }
      artistMap[artist].trackCount++;
    });

    return Object.values(artistMap)
      .sort((a, b) => b.trackCount - a.trackCount)
      .slice(0, 12);
  }

  /**
   * High-level catalog statistics for the Listening DNA bar
   */
  static getListeningStats(allTracks = [], userFavorites = [], offlineTracks = []) {
    // Handle both array arguments and object configuration arguments
    let favList = userFavorites;
    let offList = offlineTracks;
    if (userFavorites && typeof userFavorites === 'object' && !Array.isArray(userFavorites)) {
      favList = userFavorites.favoriteIds || userFavorites.favorites || [];
      offList = userFavorites.recentIds || userFavorites.offlineTracks || [];
    }

    const total = allTracks.length;
    const lrcCount = allTracks.filter(t => t.lrc && typeof t.lrc === 'string' && t.lrc.length > 20).length;
    const favCount = (favList || []).length;
    const offlineCount = (offList || []).length;

    // Distinct artists count
    const artists = new Set(allTracks.map(t => {
      const meta = this.parseFallbackMetadata(t);
      return meta.artist;
    }).filter(Boolean));

    return {
      totalTracks: total,
      total,
      syncedLyricsCount: lrcCount,
      lrcCount,
      favoriteCount: favCount,
      favCount,
      offlineCount,
      artistCount: artists.size
    };
  }
}
