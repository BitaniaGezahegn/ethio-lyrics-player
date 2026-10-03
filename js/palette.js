/**
 * Dynamic Artwork Color Palette Extractor
 * Samples album artwork via an offscreen 36x36 canvas in <1ms to extract:
 * - Dominant primary vibrant color
 * - Contrasting secondary accent
 * - Deep ambient dark background tone
 * - Luminous glow highlight
 */
export class PaletteExtractor {
  static extractFromImage(imageSource) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';

      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 36;
          canvas.height = 36;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 36, 36);

          const imageData = ctx.getImageData(0, 0, 36, 36);
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

            validColors.push({ r, g, b, sat, lum });
          }

          if (validColors.length === 0) {
            return resolve(this.getDefaultPalette());
          }

          // Prioritize vibrant saturated colors with balanced luminance
          const vibrant = validColors.filter(c => c.lum >= 0.18 && c.lum <= 0.82 && c.sat >= 0.15);
          vibrant.sort((a, b) => (b.sat * 1.5 + b.lum) - (a.sat * 1.5 + a.lum));

          const primary = vibrant.length > 0 ? vibrant[0] : validColors[0];

          // Find secondary color with chromatic distance
          let secondary = vibrant.find(c => {
            const dist = Math.abs(c.r - primary.r) + Math.abs(c.g - primary.g) + Math.abs(c.b - primary.b);
            return dist > 95;
          });

          if (!secondary) {
            secondary = {
              r: Math.min(255, Math.floor(primary.r * 0.4 + 40)),
              g: Math.min(255, Math.floor(primary.g * 0.7 + 60)),
              b: Math.min(255, Math.floor(primary.b * 1.1 + 90))
            };
          }

          // Dark tone: deep rich 12% ambient base
          const dark = {
            r: Math.floor(primary.r * 0.12),
            g: Math.floor(primary.g * 0.12),
            b: Math.floor(primary.b * 0.14)
          };

          // Glow tone
          const glow = `rgba(${primary.r}, ${primary.g}, ${primary.b}, 0.5)`;

          // Highlight tone
          const highlight = {
            r: Math.min(255, primary.r + 50),
            g: Math.min(255, primary.g + 50),
            b: Math.min(255, primary.b + 50)
          };

          resolve({
            primary: `rgb(${primary.r}, ${primary.g}, ${primary.b})`,
            secondary: `rgb(${secondary.r}, ${secondary.g}, ${secondary.b})`,
            dark: `rgb(${dark.r}, ${dark.g}, ${dark.b})`,
            glow: glow,
            highlight: `rgb(${highlight.r}, ${highlight.g}, ${highlight.b})`
          });
        } catch (e) {
          console.warn('PaletteExtractor error, falling back to default:', e);
          resolve(this.getDefaultPalette());
        }
      };

      img.onerror = () => {
        resolve(this.getDefaultPalette());
      };

      if (typeof imageSource === 'string') {
        img.src = imageSource;
      } else if (imageSource && imageSource.src) {
        img.src = imageSource.src;
      } else {
        resolve(this.getDefaultPalette());
      }
    });
  }

  static getDefaultPalette() {
    return {
      primary: '#9b1d20',
      secondary: '#1d4ed8',
      dark: '#080104',
      glow: 'rgba(155, 29, 32, 0.45)',
      highlight: '#e11d48'
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
