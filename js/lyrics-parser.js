/**
 * Robust LRC Parser and Lyrics Synchronizer
 */
export class LyricsParser {
  /**
   * Check if line looks like an Artist - Title header or track metadata
   * @param {string} text
   * @returns {boolean}
   */
  static isTitleHeader(text) {
    if (!text || typeof text !== 'string') return false;
    const t = text.trim();
    if (/[-–—]/.test(t)) return true;
    if (/^(title|artist|track|song|album|ዘፈን|ድምፃዊ|አርቲስት)\s*[:：]/i.test(t)) return true;
    return false;
  }

  /**
   * Parse LRC formatted text into structured array of { time: number, text: string }
   * @param {string} lrcContent
   * @returns {Array<{ time: number, text: string, rawTime: string }>}
   */
  static parse(lrcContent) {
    if (!lrcContent || typeof lrcContent !== 'string') return [];

    // Strip UTF-8 BOM if present (added by PowerShell or some text editors)
    lrcContent = lrcContent.replace(/^\uFEFF/, '');

    const lines = lrcContent.split(/\r?\n/);
    const parsed = [];
    const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
    // LRC metadata tags like [ti:...] [ar:...] [al:...] [by:...] — skip these
    const metaTagRegex = /^\[[a-zA-Z]+:[^\]]*\]\s*$/;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (metaTagRegex.test(trimmed)) continue; // skip metadata headers

      // Extract all timestamps in this line
      const timestamps = [];
      let match;
      timeRegex.lastIndex = 0;

      while ((match = timeRegex.exec(trimmed)) !== null) {
        const minutes = parseInt(match[1], 10);
        const seconds = parseInt(match[2], 10);
        const millisStr = match[3] || '0';
        // Normalize milliseconds: if 2 digits -> *10, if 3 digits -> ms
        const millis = millisStr.length === 2
          ? parseInt(millisStr, 10) * 10
          : parseInt(millisStr.padEnd(3, '0'), 10);
        const timeInSeconds = minutes * 60 + seconds + millis / 1000;
        timestamps.push({ time: timeInSeconds, raw: match[0] });
      }

      // If timestamps found, extract clean text
      if (timestamps.length > 0) {
        const cleanText = trimmed.replace(timeRegex, '').trim();
        for (const ts of timestamps) {
          parsed.push({
            time: ts.time,
            text: cleanText || '♪ ♪ ♪',
            rawTime: ts.raw
          });
        }
      }
    }

    // Sort chronologically
    parsed.sort((a, b) => a.time - b.time);

    return parsed;
  }

  /**
   * Find index of active line for given current timestamp
   * @param {Array} lyrics
   * @param {number} currentTime
   * @param {number} [offsetSeconds=0] Optional sync compensation / lead time in seconds
   * @returns {number} index of current line or -1
   */
  static getActiveIndex(lyrics, currentTime, offsetSeconds = 0) {
    if (!lyrics || lyrics.length === 0) return -1;

    // Compensate for hardware / perception latency
    const effectiveTime = currentTime + offsetSeconds;

    // If before first line timestamp:
    if (effectiveTime < lyrics[0].time) {
      // If line 0 is at or near 0:00 (e.g. title card), it is active
      if (lyrics[0].time <= 0.8) return 0;
      // Otherwise, instrumental intro before the first lyric
      return -1;
    }

    for (let i = lyrics.length - 1; i >= 0; i--) {
      if (effectiveTime >= lyrics[i].time) {
        return i;
      }
    }
    return 0;
  }

  /**
   * Estimate song duration in seconds from the last timestamp in LRC content
   * @param {string} lrcContent
   * @returns {number} duration in seconds (or 0 if undetermined)
   */
  static estimateDurationFromLrc(lrcContent) {
    if (!lrcContent || typeof lrcContent !== 'string') return 0;
    const parsed = this.parse(lrcContent);
    if (!parsed || parsed.length === 0) return 0;
    const maxTime = Math.max(...parsed.map(p => p.time));
    return maxTime > 0 ? Math.ceil(maxTime + 5) : 0;
  }

  /**
   * Format seconds to mm:ss display
   * @param {number} sec
   * @param {string} fallback
   * @returns {string}
   */
  static formatTime(sec, fallback = '0:00') {
    if (isNaN(sec) || sec === null || sec === undefined || sec <= 0) return fallback;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }
}
