/**
 * RecommendationEngine - Intelligent Ethio-Music Discovery & Recommendation System
 * 
 * Features:
 * 1. Multi-factor user affinity scoring (plays, favorites, full listens, recent context)
 * 2. Time-of-day contextual vibes (Morning Uplift, Afternoon Rhythms, Evening Tizita, Late Night Soul)
 * 3. Ethiopian music categorization (Tizita/Vintage Golden Era, Modern Addis Pop, Synced Lyrics Showcase)
 * 4. Context-aware "Because you listened to [Artist]" recommendation seeds
 * 5. Quick Resume / Jump Back In shelf generation
 * 6. Iconic Ethiopian artist clustering and discovery
 */

export class RecommendationEngine {
  /**
   * Determine time-of-day greeting and Ethiopian musical mood
   */
  static getGreetingData(userName = '') {
    const now = new Date();
    const hour = now.getHours();
    const displayName = userName && userName !== 'Music Lover' ? userName : '';

    if (hour >= 5 && hour < 12) {
      return {
        period: 'morning',
        greetingAm: 'እንደምን አደሩ',
        greetingEn: displayName ? `Good morning, ${displayName}` : 'Good morning',
        moodTag: 'Morning Harmony 🌅',
        moodTagAm: 'የጥዋት ዜማ',
        moodSubtitle: 'Fresh, spiritual, and inspiring Ethiopian melodies to start your day',
        accentColor: '#f59e0b'
      };
    } else if (hour >= 12 && hour < 17) {
      return {
        period: 'afternoon',
        greetingAm: 'እንደምን ዋሉ',
        greetingEn: displayName ? `Good afternoon, ${displayName}` : 'Good afternoon',
        moodTag: 'Addis Groove ☀️',
        moodTagAm: 'የቀትር ምት',
        moodSubtitle: 'Upbeat rhythms, contemporary hits, and vibrant Ethiopian grooves',
        accentColor: '#3b82f6'
      };
    } else if (hour >= 17 && hour < 22) {
      return {
        period: 'evening',
        greetingAm: 'እንደምን አመሹ',
        greetingEn: displayName ? `Good evening, ${displayName}` : 'Good evening',
        moodTag: 'Nightfall Tizita 🌆',
        moodTagAm: 'የምሽት ትዝታ',
        moodSubtitle: 'Mellow soul, acoustic memories, and deep synchronized lyrics',
        accentColor: '#ec4899'
      };
    } else {
      return {
        period: 'night',
        greetingAm: 'ደህና እደሩ',
        greetingEn: displayName ? `Late Night Vibes, ${displayName}` : 'Late Night Vibes',
        moodTag: 'Midnight Tizita 🌙',
        moodTagAm: 'የለሊት ዝማሬ',
        moodSubtitle: 'Introspective melodies, vintage nostalgia, and soothing ballads',
        accentColor: '#8b5cf6'
      };
    }
  }

  /**
   * Quick resume / Jump Back In tracks (Spotify-style quick launch pad)
   */
  static getJumpBackIn(allTracks, recentlyPlayedIds = [], favoriteIds = [], limit = 6) {
    if (!allTracks || allTracks.length === 0) return [];
    const pool = [];
    const seenIds = new Set();

    // 1. Add recent tracks first
    (recentlyPlayedIds || []).forEach(id => {
      const match = allTracks.find(t => t.id === id);
      if (match && !seenIds.has(match.id)) {
        pool.push(match);
        seenIds.add(match.id);
      }
    });

    // 2. Supplement with favorites if recent is less than limit
    if (pool.length < limit) {
      (favoriteIds || []).forEach(id => {
        const match = allTracks.find(t => t.id === id);
        if (match && !seenIds.has(match.id)) {
          pool.push(match);
          seenIds.add(match.id);
        }
      });
    }

    // 3. Fallback to catalog tracks with rich lyrics if still less than limit
    if (pool.length < limit) {
      allTracks.forEach(t => {
        if (!seenIds.has(t.id) && pool.length < limit) {
          pool.push(t);
          seenIds.add(t.id);
        }
      });
    }

    return pool.slice(0, limit);
  }

  /**
   * Multi-factor scoring recommendation engine ("Made For You / Smart Mix")
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

    // Calculate artist frequency weights
    const artistScores = {};
    recentList.forEach((id, idx) => {
      const tr = allTracks.find(t => t.id === id);
      if (tr && tr.artist) {
        // More recent tracks have higher weight
        const recencyMultiplier = Math.max(1, 5 - idx * 0.5);
        artistScores[tr.artist] = (artistScores[tr.artist] || 0) + (3 * recencyMultiplier);
      }
    });

    favorites.forEach(id => {
      const tr = allTracks.find(t => t.id === id);
      if (tr && tr.artist) {
        artistScores[tr.artist] = (artistScores[tr.artist] || 0) + 6;
      }
    });

    if (currentTrack && currentTrack.artist) {
      artistScores[currentTrack.artist] = (artistScores[currentTrack.artist] || 0) + 4;
    }

    // Score and filter each track
    const scored = allTracks.map(track => {
      let score = 0;
      const meta = this.parseFallbackMetadata(track);
      const artistName = meta.artist;

      // 1. Synchronized Lyrics Richness (+14 pts) - Flagship experience!
      if (track.lrc && typeof track.lrc === 'string' && track.lrc.length > 25) {
        score += 14;
        if (track.lrc.length > 150) score += 4; // Extensive full lyrics
      }

      // 2. Artist Affinity (works even with fallback parsed artist name!)
      if (artistName && artistScores[artistName]) {
        score += Math.min(22, artistScores[artistName]);
      }

      // 3. User Engagement (Favorites)
      if (favSet.has(track.id)) {
        score += 10;
      }

      // 4. Offline downloaded track ready for playback
      if (track.isDownloaded || track.audioBlob) {
        score += 5;
      }

      // 5. Authentic Ethiopic Fidel presence bonus
      if (meta.hasEthiopic) {
        score += 3;
      }

      // 6. Diversity / Anti-Fatigue: Slight reduction if it was the EXACT last played track
      if (currentTrack && currentTrack.id === track.id) {
        score -= 8;
      } else if (recentList.length > 0 && recentList[0] === track.id) {
        score -= 4;
      }

      // 7. Time of Day & Ethiopian Musical Scale/Vibe Match
      const hour = new Date().getHours();
      const isLateOrEvening = hour >= 18 || hour < 6;
      const isClassic = (track.year && parseInt(track.year) < 2010) || 
                        meta.vibe === 'tizita' ||
                        (track.album && /tizita|classic|vintage|memories|ትዝታ/i.test(track.album)) ||
                        (track.title && /tizita|ትዝታ/i.test(track.title));

      if (isLateOrEvening) {
        if (isClassic || meta.vibe === 'tizita' || meta.vibe === 'bati' || meta.vibe === 'anchihoye') {
          score += 7; // Evening & night bonus for Tizita / Bati / Soul
        }
      } else {
        if (meta.vibe === 'eskista' || meta.vibe === 'gurage' || meta.vibe === 'pop' || meta.vibe === 'reggae') {
          score += 6; // Daytime energetic groove bonus
        }
      }

      // 8. Cold-Start Novelty Exploration (Multi-Armed Bandit):
      // If a song has zero plays and sparse metadata, give it an exploration lift so it surfaces for users to discover!
      if (!recentSet.has(track.id) && !favSet.has(track.id)) {
        score += 3.5;
      }

      // 9. Subtle dynamic jitter (±2.5) to keep discovery fresh each time
      const jitter = (Math.random() * 5) - 2.5;
      score += jitter;

      return { track, score };
    });

    // Apply active vibe filtering if specified
    let filtered = scored;
    if (activeVibe === 'lrc') {
      filtered = filtered.filter(item => item.track.lrc && item.track.lrc.length > 15);
    } else if (activeVibe === 'classic') {
      filtered = filtered.filter(item => {
        const t = item.track;
        return (t.year && parseInt(t.year) < 2010) ||
               (t.album && /tizita|classic|vintage|oldies|ትዝታ/i.test(t.album)) ||
               (t.title && /tizita|ትዝታ/i.test(t.title));
      });
    } else if (activeVibe === 'pop') {
      filtered = filtered.filter(item => {
        const t = item.track;
        return (!t.year || parseInt(t.year) >= 2010);
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
   * "Because You Listened To [Artist / Song]" Seed Shelf
   * Identifies the strongest listening anchor and finds complementary cuts
   */
  static getBecauseYouListenedShelf(allTracks, { recentlyPlayed = [], favorites = [], currentTrack = null } = {}) {
    if (!allTracks || allTracks.length < 2) return null;

    // Pick seed track or artist
    let seedTrack = currentTrack;
    if (!seedTrack && recentlyPlayed.length > 0) {
      seedTrack = allTracks.find(t => t.id === recentlyPlayed[0]);
    }
    if (!seedTrack && favorites.length > 0) {
      seedTrack = allTracks.find(t => t.id === favorites[0]);
    }
    if (!seedTrack) {
      seedTrack = allTracks[0];
    }

    if (!seedTrack) return null;

    const seedArtist = seedTrack.artist;
    const seedId = seedTrack.id;

    // Match tracks by same artist or similar era
    let matches = allTracks.filter(t => t.id !== seedId && t.artist === seedArtist);

    // If same artist has few songs, supplement with complementary tracks
    if (matches.length < 4) {
      const era = seedTrack.year ? parseInt(seedTrack.year) : 2020;
      const isVintage = era < 2010;
      const complementary = allTracks.filter(t => {
        if (t.id === seedId || matches.includes(t)) return false;
        const tEra = t.year ? parseInt(t.year) : 2020;
        return isVintage ? tEra < 2010 : tEra >= 2010;
      });
      matches = [...matches, ...complementary];
    }

    if (matches.length === 0) return null;

    return {
      seedTrack,
      seedArtist,
      title: `Because You Listened To ${seedArtist}`,
      titleAm: `${seedArtist}ን ስላደመጡ የተመረጡ`,
      subtitle: `Similar Ethiopian melodies and vocal vibes inspired by "${seedTrack.title}"`,
      tracks: matches.slice(0, 8)
    };
  }

  /**
   * Showcase of tracks with rich, verified synchronized Amharic lyrics
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
    if (!track) return { title: 'Untitled', artist: 'Unknown Artist', hasEthiopic: false, vibe: 'general' };

    let title = (track.title || '').trim();
    let artist = (track.artist || '').trim();

    // If artist is unknown or missing, try splitting title pattern "Artist - Song"
    if ((!artist || artist.toLowerCase() === 'unknown artist') && title) {
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

    // Clean up audio file extensions from title
    title = title.replace(/\.(mp3|m4a|wav|aac|flac|ogg)$/i, '').trim();

    // Check for Ethiopic Fidel characters (\u1200-\u137F)
    const hasEthiopic = /[\u1200-\u137F]/.test(title + ' ' + artist + ' ' + (track.lrc || ''));

    // Detect Ethiopian traditional scales & regional rhythms
    const vibe = this.detectEthioVibe(track, title);

    return {
      title: title || 'Untitled Track',
      artist: artist || 'Ethiopian Artist',
      hasEthiopic,
      vibe
    };
  }

  /**
   * Detect Ethiopian musical scale / style from available text clues or LRC structure
   */
  static detectEthioVibe(track, cleanTitle = '') {
    const combined = `${cleanTitle} ${track.title || ''} ${track.artist || ''} ${track.album || ''}`.toLowerCase();

    if (/tizita|tezita|ትዝታ/i.test(combined)) return 'tizita';
    if (/bati|ባቲ/i.test(combined)) return 'bati';
    if (/ambassel|ambasel|አምባሰል/i.test(combined)) return 'ambassel';
    if (/anchihoye|anchi hoye|አንቺሆዬ/i.test(combined)) return 'anchihoye';
    if (/eskista|iskista|እስክስታ/i.test(combined)) return 'eskista';
    if (/gurage|guragigna|ጉራጌ/i.test(combined)) return 'gurage';
    if (/oromo|oromiffa|oromiyaa|ኦሮሞ/i.test(combined)) return 'oromo';
    if (/wollo|manzuma|ወሎ/i.test(combined)) return 'wollo';
    if (/tigrigna|tigray|ትግርኛ/i.test(combined)) return 'tigrigna';
    if (/jazz|mulatu|instrumental/i.test(combined)) return 'ethiojazz';
    if (/reggae|teddy afro|ዳውን/i.test(combined)) return 'reggae';

    // Acoustic / duration structural clue: Longer tracks (> 5 mins) are typically nostalgic Tizita ballads
    if (track.duration && track.duration > 320) return 'tizita';
    if (track.duration && track.duration < 210) return 'pop';

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
          cover: track.cover || 'assets/weleta_cover.jpg',
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
