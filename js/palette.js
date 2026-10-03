/**
 * Dynamic Artwork Color Palette Extractor
 * Ultra-compatible across Mobile (iOS WebKit / Android Chrome) and Desktop.
 * Uses Blob ObjectURLs to prevent tainted-canvas SecurityErrors on mobile browsers.
 */
export class PaletteExtractor {
  static _cache = new Map();

  static async extractFromImage(imageSource) {
    if (!imageSource) return this.getDefaultPalette();

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
            canvas.width = 48;
            canvas.height = 48;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, 48, 48);

            const imageData = ctx.getImageData(0, 0, 48, 48);
            const data = imageData.data;

            const validColors = [];
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i];
              const g = data[i + 1];
              const b = data[i + 2];
              const a = data[i + 3];

              if (a < 128) continue;

              const max = Math.max(r, g, b);
              const min = Math.min(r, g, b);
              const lum = (max + min) / 510;
              const sat = max === 0 ? 0 : (max - min) / max;

              // Filter out extreme pitch blacks and pure whites for vibrant tones
              if (lum > 0.08 && lum < 0.92) {
                validColors.push({ r, g, b, sat, lum });
              }
            }

            if (validColors.length === 0) {
              return resolve(this.getDefaultPalette());
            }

            // Rank by saturation and chromatic interest
            validColors.sort((a, b) => {
              const scoreA = a.sat * 2.0 + (1 - Math.abs(a.lum - 0.5));
              const scoreB = b.sat * 2.0 + (1 - Math.abs(b.lum - 0.5));
              return scoreB - scoreA;
            });

            const primary = validColors[0];

            // Find complementary / distinct secondary color
            let secondary = validColors.find(c => {
              const dist = Math.abs(c.r - primary.r) + Math.abs(c.g - primary.g) + Math.abs(c.b - primary.b);
              return dist > 80;
            });

            if (!secondary) {
              // Synthesize a harmonious complementary tone
              secondary = {
                r: Math.min(255, Math.max(0, Math.floor(primary.r * 0.4 + 30))),
                g: Math.min(255, Math.max(0, Math.floor(primary.g * 0.8 + 40))),
                b: Math.min(255, Math.max(0, Math.floor(primary.b * 1.2 + 60)))
              };
            }

            // Ambient dark base (10-15% of primary)
            const dark = {
              r: Math.floor(primary.r * 0.12),
              g: Math.floor(primary.g * 0.12),
              b: Math.floor(primary.b * 0.14)
            };

            const result = {
              primary: `rgb(${primary.r}, ${primary.g}, ${primary.b})`,
              secondary: `rgb(${secondary.r}, ${secondary.g}, ${secondary.b})`,
              dark: `rgb(${dark.r}, ${dark.g}, ${dark.b})`,
              glow: `rgba(${primary.r}, ${primary.g}, ${primary.b}, 0.55)`,
              highlight: `rgb(${Math.min(255, primary.r + 40)}, ${Math.min(255, primary.g + 40)}, ${Math.min(255, primary.b + 40)})`
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

      if (cacheKey) this._cache.set(cacheKey, palette);
      return palette;
    } catch (outerErr) {
      console.warn('PaletteExtractor outer error:', outerErr);
      return this.getDefaultPalette();
    }
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
