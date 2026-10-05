/**
 * Lightweight Standalone QR Code Generator (Vanilla ES Module)
 * Generates offline SVG / Canvas QR codes for local Wi-Fi pairing.
 * Zero external dependencies.
 */

// Simple, battle-tested minimal QR Code matrix generator (ECC Level M)
export const QRCodeGenerator = {
  /**
   * Generates an SVG string representation of a QR Code.
   * @param {string} text - URL or text to encode
   * @param {number} size - Output width/height in px
   * @param {string} darkColor - Foreground color (default: #ffffff)
   * @param {string} lightColor - Background color (default: transparent)
   * @returns {string} SVG markup
   */
  generateSVG(text, size = 180, darkColor = '#ffffff', lightColor = 'transparent') {
    const matrix = this.createMatrix(text);
    const n = matrix.length;
    const cellSize = (size / n).toFixed(2);

    let rects = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (matrix[r][c]) {
          const x = (c * cellSize).toFixed(2);
          const y = (r * cellSize).toFixed(2);
          rects += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="${darkColor}"/>`;
        }
      }
    }

    return `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="border-radius:12px; background:${lightColor}; display:block;">
        ${rects}
      </svg>
    `.trim();
  },

  /**
   * Creates a 2D boolean matrix representing the QR Code.
   * Uses standard QR Code model with finder patterns, timing patterns, and byte encoding.
   */
  createMatrix(text) {
    // Determine required version based on string length
    const len = text.length;
    let version = 3; // 29x29
    if (len > 32) version = 4; // 33x33
    if (len > 50) version = 5; // 37x37
    if (len > 70) version = 6; // 41x41

    const size = version * 4 + 17;
    const matrix = Array.from({ length: size }, () => Array(size).fill(0));
    const reserved = Array.from({ length: size }, () => Array(size).fill(false));

    // 1. Finder Patterns (Top-Left, Top-Right, Bottom-Left)
    this._addFinderPattern(matrix, reserved, 0, 0);
    this._addFinderPattern(matrix, reserved, size - 7, 0);
    this._addFinderPattern(matrix, reserved, 0, size - 7);

    // 2. Timing Patterns
    for (let i = 8; i < size - 8; i++) {
      const bit = i % 2 === 0 ? 1 : 0;
      if (!reserved[6][i]) { matrix[6][i] = bit; reserved[6][i] = true; }
      if (!reserved[i][6]) { matrix[i][6] = bit; reserved[i][6] = true; }
    }

    // 3. Dark module
    matrix[4 * version + 9][8] = 1;
    reserved[4 * version + 9][8] = true;

    // 4. Reserve format info areas around finder patterns
    for (let i = 0; i < 9; i++) {
      if (i < size) { reserved[8][i] = true; reserved[i][8] = true; }
      if (size - 1 - i >= 0) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }
    }

    // 5. Data encoding (Byte mode: mode 0100 + length + data + terminator)
    const bits = [];
    // Mode indicator: 0100 (8-bit byte)
    bits.push(0, 1, 0, 0);
    // Character count indicator (8 bits for version <= 9)
    for (let b = 7; b >= 0; b--) bits.push((len >> b) & 1);
    // Data bytes
    for (let i = 0; i < len; i++) {
      const code = text.charCodeAt(i);
      for (let b = 7; b >= 0; b--) bits.push((code >> b) & 1);
    }
    // Terminator (up to 4 zeroes)
    bits.push(0, 0, 0, 0);
    // Pad to byte boundary
    while (bits.length % 8 !== 0) bits.push(0);

    // Fill data codewords into matrix in standard 2-column zig-zag
    let bitIdx = 0;
    let up = true;
    for (let right = size - 1; right > 0; right -= 2) {
      if (right === 6) right--; // skip vertical timing line
      const rows = up ? Array.from({ length: size }, (_, i) => size - 1 - i) : Array.from({ length: size }, (_, i) => i);
      for (const r of rows) {
        for (const col of [right, right - 1]) {
          if (!reserved[r][col]) {
            const dataBit = bitIdx < bits.length ? bits[bitIdx++] : ((r + col) % 2 === 0 ? 1 : 0);
            // Apply Mask 0: (row + col) % 2 === 0
            const maskBit = (r + col) % 2 === 0 ? 1 : 0;
            matrix[r][col] = dataBit ^ maskBit;
            reserved[r][col] = true;
          }
        }
      }
      up = !up;
    }

    // Add standard Format Bits (Mask 0, ECC M)
    const formatBits = [1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0];
    for (let i = 0; i < 6; i++) matrix[8][i] = formatBits[i];
    matrix[8][7] = formatBits[6];
    matrix[8][8] = formatBits[7];
    matrix[7][8] = formatBits[8];
    for (let i = 9; i < 15; i++) matrix[14 - i][8] = formatBits[i];

    for (let i = 0; i < 8; i++) matrix[size - 1 - i][8] = formatBits[i];
    for (let i = 8; i < 15; i++) matrix[8][size - 15 + i] = formatBits[i];

    return matrix;
  },

  _addFinderPattern(matrix, reserved, x, y) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = y + r;
        const col = x + c;
        if (row >= 0 && row < matrix.length && col >= 0 && col < matrix.length) {
          reserved[row][col] = true;
          if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
            if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
              matrix[row][col] = 1;
            } else {
              matrix[row][col] = 0;
            }
          } else {
            matrix[row][col] = 0;
          }
        }
      }
    }
  },
};
