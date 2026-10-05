/**
 * Standard QR Code Generator (Vanilla ES Module)
 * Uses ISO/IEC 18004 compliant QR generator with Reed-Solomon Error Correction.
 * 100% offline, zero runtime CDN calls.
 */

import './libs/qrcode.min.js';

export const QRCodeGenerator = {
  /**
   * Generates a standard SVG QR Code string.
   * @param {string} text - URL or text to encode
   * @param {number} size - Desired width/height in px
   * @param {string} darkColor - Foreground color (default: #000000)
   * @param {string} lightColor - Background color (default: #ffffff)
   * @returns {string} Clean SVG markup
   */
  generateSVG(text, size = 220, darkColor = '#000000', lightColor = '#ffffff') {
    if (!text) return '';

    // Standard qrcode generator (auto version 0, Error Correction M)
    const qrcodeFn = (typeof window !== 'undefined' && window.qrcode) 
      ? window.qrcode 
      : (typeof globalThis !== 'undefined' && globalThis.qrcode ? globalThis.qrcode : null);

    if (!qrcodeFn) {
      console.error('[QRCodeGenerator] qrcode library not loaded.');
      return '';
    }

    try {
      const qr = qrcodeFn(0, 'M');
      qr.addData(text);
      qr.make();

      const count = qr.getModuleCount();
      const cellSize = Math.max(3, Math.floor(size / count));
      const margin = 2 * cellSize;
      const totalSize = count * cellSize + margin * 2;

      let rects = '';
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) {
            const x = margin + c * cellSize;
            const y = margin + r * cellSize;
            rects += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="${darkColor}"/>`;
          }
        }
      }

      return `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="${size}" height="${size}" style="border-radius:12px; background:${lightColor}; display:block; margin:0 auto; box-shadow:0 4px 16px rgba(0,0,0,0.3);">
          <rect width="100%" height="100%" fill="${lightColor}"/>
          ${rects}
        </svg>
      `.trim();
    } catch (err) {
      console.warn('[QRCodeGenerator] Error generating QR code:', err);
      return '';
    }
  }
};
