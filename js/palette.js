/**
 * Dynamic Artwork Color Palette Extractor
 * Ultra-compatible across Mobile (iOS WebKit / Android Chrome) and Desktop.
 * Uses Blob ObjectURLs to prevent tainted-canvas SecurityErrors on mobile browsers.
 */
export class PaletteExtractor {
  static _cache = new Map();

  static _cacheSet(key, val) {
    if (!key) return;
    if (this._cache.size >= 50) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    this._cache.set(key, val);
  }

  static async extractFromImage(imageSource) {
    if (!imageSource || (typeof imageSource === 'string' && imageSource.includes('elm-default-cover'))) {
      return this.getDefaultPalette();
    }

    const cacheKey = typeof imageSource === 'string' ? imageSource : imageSource.src;
    if (cacheKey && this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    try {
      let resolvedSrc = cacheKey;
      let isBlobCreated = false;

      // For remote HTTP/HTTPS images, fetch as Blob first to bypass mobile canvas cross-origin taint
      if (typeof cacheKey === 'string' && cacheKey.startsWith('http')) {
        try {
          const res = await fetch(cacheKey, { mode: 'cors' });
          if (res.ok) {
            const blob = await res.blob();
            resolvedSrc = URL.createObjectURL(blob);
            isBlobCreated = true;
          }
        } catch (fetchErr) {
          console.warn('Direct blob fetch failed, falling back to direct image loading:', fetchErr);
        }
      }

      const palette = await new Promise((resolve) => {
        const img = new Image();
        // Do not set crossOrigin if already a local blob or data URL
        if (!resolvedSrc.startsWith('blob:') && !resolvedSrc.startsWith('data:')) {
          img.crossOrigin = 'Anonymous';
        }

        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            const size = 24;
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, size, size);

            const data = ctx.getImageData(0, 0, size, size).data;

            // Single-pass O(N) scan without sorting arrays
            let primary = null;
            let bestScore = -1;
            const samples = [];

            for (let i = 0; i < data.length; i += 8) { // sample every 2nd pixel (~288 samples)
              const r = data[i];
              const g = data[i + 1];
              const b = data[i + 2];
              const a = data[i + 3];
              if (a < 128) continue;

              const max = Math.max(r, g, b);
              const min = Math.min(r, g, b);
              const lum = (max + min) / 510;
              if (lum <= 0.08 || lum >= 0.92) continue;

              const sat = max === 0 ? 0 : (max - min) / max;
              const score = sat * 2.0 + (1 - Math.abs(lum - 0.5));
              samples.push({ r, g, b, score });
              if (score > bestScore) {
                bestScore = score;
                primary = { r, g, b };
              }
            }

            if (!primary) {
              return resolve(this.getDefaultPalette());
            }

            // Pick highest-scoring sample sufficiently distinct from primary
            let secondary = null;
            let bestSecScore = -1;
            for (let i = 0; i < samples.length; i++) {
              const c = samples[i];
              const dist = Math.abs(c.r - primary.r) + Math.abs(c.g - primary.g) + Math.abs(c.b - primary.b);
              if (dist > 80 && c.score > bestSecScore) {
                bestSecScore = c.score;
                secondary = c;
              }
            }

            if (!secondary) {
              secondary = {
                r: Math.min(255, Math.max(0, Math.floor(primary.r * 0.4 + 30))),
                g: Math.min(255, Math.max(0, Math.floor(primary.g * 0.8 + 40))),
                b: Math.min(255, Math.max(0, Math.floor(primary.b * 1.2 + 60)))
              };
            }

            // Clamp accent lightness/saturation and keep dark backdrop contrast high
            const adjPrimary = this._clampAccentRgb(primary, { minL: 0.44, maxL: 0.66, minS: 0.42 });
            const adjSecondary = this._clampAccentRgb(secondary, { minL: 0.40, maxL: 0.62, minS: 0.35 });
            const adjHighlight = this._clampAccentRgb(adjPrimary, { minL: 0.68, maxL: 0.80, minS: 0.45 });
            const dark = this._clampAccentRgb(adjPrimary, { minL: 0.04, maxL: 0.09, minS: 0.25 });

            const result = {
              primary: `rgb(${adjPrimary.r}, ${adjPrimary.g}, ${adjPrimary.b})`,
              secondary: `rgb(${adjSecondary.r}, ${adjSecondary.g}, ${adjSecondary.b})`,
              dark: `rgb(${dark.r}, ${dark.g}, ${dark.b})`,
              glow: `rgba(${adjPrimary.r}, ${adjPrimary.g}, ${adjPrimary.b}, 0.52)`,
              highlight: `rgb(${adjHighlight.r}, ${adjHighlight.g}, ${adjHighlight.b})`
            };

            resolve(result);
          } catch (canvasErr) {
            console.warn('Canvas pixel extraction failed on mobile:', canvasErr);
            resolve(this.getDefaultPalette());
          } finally {
            if (isBlobCreated) {
              URL.revokeObjectURL(resolvedSrc);
            }
          }
        };

        img.onerror = () => {
          if (isBlobCreated) URL.revokeObjectURL(resolvedSrc);
          resolve(this.getDefaultPalette());
        };

        img.src = resolvedSrc;
      });

      this._cacheSet(cacheKey, palette);
      return palette;
    } catch (outerErr) {
      console.warn('PaletteExtractor outer error:', outerErr);
      return this.getDefaultPalette();
    }
  }

  static _clampAccentRgb(rgb, { minL = 0.42, maxL = 0.68, minS = 0.35 } = {}) {
    let r = (rgb.r || 0) / 255;
    let g = (rgb.g || 0) / 255;
    let b = (rgb.b || 0) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    let l = (max + min) / 2;

    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }

    // Preserve muted gray artwork gracefully if near monochrome, otherwise boost saturation floor
    if (s > 0.08 && s < minS) s = minS;
    l = Math.min(maxL, Math.max(minL, l));

    if (s === 0) {
      const gray = Math.round(l * 255);
      return { r: gray, g: gray, b: gray };
    }

    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      g: Math.round(hue2rgb(p, q, h) * 255),
      b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
    };
  }

  static getDefaultPalette() {
    return {
      primary: '#10b981', // Refreshing emerald green default rather than red
      secondary: '#06b6d4',
      dark: '#05130e',
      glow: 'rgba(16, 185, 129, 0.45)',
      highlight: '#34d399'
    };
  }

  static applyToElement(element, palette) {
    if (!element || !palette) return;
    element.style.setProperty('--art-primary', palette.primary);
    element.style.setProperty('--art-secondary', palette.secondary);
    element.style.setProperty('--art-dark', palette.dark);
    element.style.setProperty('--art-glow', palette.glow);
    element.style.setProperty('--art-highlight', palette.highlight);
  }
}
