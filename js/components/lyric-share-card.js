import { escapeHtml } from '../utils/sanitize.js';

/**
 * Generates shareable 1080x1350 lyric quote cards using an offscreen CORS-safe Canvas
 * and supports Download PNG, Web Share API file sharing, and Copy Text.
 */
class LyricShareCardManager {
  constructor() {
    this._overlay = null;
    this._track = null;
    this._lines = [];
    this._selectedIndices = new Set();
    this._stylePreset = 'palette'; // 'palette' | 'obsidian' | 'sunrise'
    this._palette = { primary: '#10b981', secondary: '#06b6d4', dark: '#071310' };
    this._onToast = null;
    this._coverBitmap = null;
    this._renderSeq = 0;
  }

  _ensureDom() {
    if (this._overlay || typeof document === 'undefined') return;
    const overlay = document.createElement('div');
    overlay.id = 'elmLyricShareOverlay';
    overlay.className = 'modal-overlay lyric-share-overlay';
    overlay.innerHTML = `
      <div class="modal-card lyric-share-card-modal">
        <div class="modal-header">
          <div style="display:flex; align-items:center; gap:0.6rem;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-gold)" stroke-width="2">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
              <polyline points="16 6 12 2 8 6"/>
              <line x1="12" y1="2" x2="12" y2="15"/>
            </svg>
            <div>
              <h2 style="font-size:1.05rem; margin:0; font-weight:700;">Share Lyric Card</h2>
              <div style="font-size:0.74rem; color:var(--color-text-dim);">Pick 1–4 lines to export a quote card</div>
            </div>
          </div>
          <button type="button" class="modal-close-btn" id="elmShareCardClose">&times;</button>
        </div>
        <div class="lyric-share-body">
          <div class="lyric-share-preview-col">
            <canvas id="elmSharePreviewCanvas" width="1080" height="1350" class="lyric-share-canvas"></canvas>
            <div class="lyric-share-presets">
              <button type="button" class="share-preset-btn active" data-share-style="palette">Artwork</button>
              <button type="button" class="share-preset-btn" data-share-style="obsidian">Obsidian</button>
              <button type="button" class="share-preset-btn" data-share-style="sunrise">Sunrise</button>
            </div>
          </div>
          <div class="lyric-share-lines-col">
            <div class="lyric-share-hint">Tap up to 4 lyric lines:</div>
            <div id="elmShareLinePicker" class="lyric-share-picker"></div>
            <div class="lyric-share-actions">
              <button type="button" id="elmShareBtnNative" class="btn-primary" style="flex:1;">Share Card</button>
              <button type="button" id="elmShareBtnDownload" class="btn-pill" style="flex:1;">Save PNG</button>
              <button type="button" id="elmShareBtnCopy" class="btn-pill">Copy Text</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this._overlay = overlay;

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });
    overlay.querySelector('#elmShareCardClose').addEventListener('click', () => this.close());
    overlay.querySelectorAll('[data-share-style]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._stylePreset = btn.dataset.shareStyle || 'palette';
        overlay.querySelectorAll('[data-share-style]').forEach((b) => b.classList.toggle('active', b === btn));
        this._drawCanvas();
      });
    });

    overlay.querySelector('#elmShareBtnDownload').addEventListener('click', () => this._downloadPng());
    overlay.querySelector('#elmShareBtnNative').addEventListener('click', () => this._nativeShare());
    overlay.querySelector('#elmShareBtnCopy').addEventListener('click', () => this._copyQuoteText());
  }

  close() {
    if (this._overlay) this._overlay.classList.remove('active');
    if (this._coverObjectUrl) {
      URL.revokeObjectURL(this._coverObjectUrl);
      this._coverObjectUrl = null;
    }
    this._coverBitmap = null;
  }

  async open({ track, parsedLyrics = [], initialIndex = 0, palette = null, onToast = null } = {}) {
    if (typeof document === 'undefined' || !track) return;
    this._ensureDom();
    this._track = track;
    this._onToast = onToast;
    this._lines = (parsedLyrics || []).filter((l) => l && l.text && l.text.trim());
    if (palette) this._palette = palette;

    this._selectedIndices = new Set();
    if (this._lines.length > 0) {
      const start = Math.max(0, Math.min(this._lines.length - 1, initialIndex >= 0 ? initialIndex : 0));
      this._selectedIndices.add(start);
      if (start + 1 < this._lines.length) this._selectedIndices.add(start + 1);
    }

    this._renderLinePicker();
    this._overlay.classList.add('active');
    this._coverBitmap = null;

    const seq = ++this._renderSeq;
    await this._drawCanvas();
    const img = await this._loadCorsSafeCover(track.cover);
    if (seq !== this._renderSeq) return;
    this._coverBitmap = img;
    await this._drawCanvas();
  }

  _notify(msg) {
    if (typeof this._onToast === 'function') this._onToast(msg);
  }

  _renderLinePicker() {
    const picker = this._overlay?.querySelector('#elmShareLinePicker');
    if (!picker) return;

    if (this._lines.length === 0) {
      picker.innerHTML = `<div class="lyric-share-empty">No lyric lines available for this track yet — generating artwork quote card.</div>`;
      return;
    }

    picker.innerHTML = this._lines.map((line, i) => `
      <button type="button" class="lyric-share-pick-btn ${this._selectedIndices.has(i) ? 'selected' : ''}" data-pick-idx="${i}">
        ${escapeHtml(line.text)}
      </button>
    `).join('');

    picker.querySelectorAll('[data-pick-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.pickIdx, 10);
        if (this._selectedIndices.has(idx)) {
          if (this._selectedIndices.size > 1) {
            this._selectedIndices.delete(idx);
          }
        } else {
          if (this._selectedIndices.size >= 4) {
            const first = Array.from(this._selectedIndices).sort((a, b) => a - b)[0];
            this._selectedIndices.delete(first);
          }
          this._selectedIndices.add(idx);
        }
        picker.querySelectorAll('[data-pick-idx]').forEach((b) => {
          b.classList.toggle('selected', this._selectedIndices.has(parseInt(b.dataset.pickIdx, 10)));
        });
        this._drawCanvas();
      });
    });
  }

  _getSelectedLinesText() {
    if (this._lines.length === 0) {
      return [this._track?.album ? `${this._track.title} — ${this._track.album}` : (this._track?.title || 'ELM')];
    }
    return Array.from(this._selectedIndices)
      .sort((a, b) => a - b)
      .map((i) => this._lines[i]?.text)
      .filter(Boolean);
  }

  async _loadCorsSafeCover(coverUrl) {
    if (!coverUrl || coverUrl.includes('elm-default-cover')) return null;
    try {
      let src = coverUrl;
      if (coverUrl.startsWith('http')) {
        const res = await fetch(coverUrl, { mode: 'cors' });
        if (!res.ok) return null;
        const blob = await res.blob();
        if (this._coverObjectUrl) URL.revokeObjectURL(this._coverObjectUrl);
        src = URL.createObjectURL(blob);
        this._coverObjectUrl = src;
      }
      return await new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
      });
    } catch {
      return null;
    }
  }

  async _drawCanvas() {
    const canvas = this._overlay?.querySelector('#elmSharePreviewCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    let c1 = this._palette.primary || '#10b981';
    let c2 = this._palette.secondary || '#06b6d4';
    let bg = this._palette.dark || '#081210';

    if (this._stylePreset === 'obsidian') {
      c1 = '#e5b95a';
      c2 = '#9333ea';
      bg = '#0c0812';
    } else if (this._stylePreset === 'sunrise') {
      c1 = '#f43f5e';
      c2 = '#f59e0b';
      bg = '#1a0a12';
    }

    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, bg);
    grad.addColorStop(0.55, '#0b0a10');
    grad.addColorStop(1, '#07050a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Glow blobs
    const g1 = ctx.createRadialGradient(w * 0.2, h * 0.2, 20, w * 0.2, h * 0.2, 540);
    g1.addColorStop(0, c1);
    g1.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, w, h);

    const g2 = ctx.createRadialGradient(w * 0.85, h * 0.85, 20, w * 0.85, h * 0.85, 520);
    g2.addColorStop(0, c2);
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // Inner glass frame
    this._roundRect(ctx, 72, 72, w - 144, h - 144, 48);
    ctx.fillStyle = 'rgba(18, 12, 20, 0.72)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.stroke();

    // Artwork header
    const artX = 128;
    const artY = 128;
    const artSize = 160;
    ctx.save();
    this._roundRect(ctx, artX, artY, artSize, artSize, 24);
    ctx.clip();
    if (this._coverBitmap) {
      ctx.drawImage(this._coverBitmap, artX, artY, artSize, artSize);
    } else {
      ctx.fillStyle = c1;
      ctx.fillRect(artX, artY, artSize, artSize);
      ctx.fillStyle = '#09090b';
      ctx.font = 'bold 54px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('ELM', artX + artSize / 2, artY + artSize / 2);
    }
    ctx.restore();

    // Title & Artist
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 42px "Noto Sans Ethiopic", "Segoe UI", sans-serif';
    ctx.fillText(this._truncateText(ctx, this._track?.title || 'Untitled', 640), 320, 152);

    ctx.fillStyle = 'rgba(226, 232, 240, 0.78)';
    ctx.font = '500 30px "Noto Sans Ethiopic", "Segoe UI", sans-serif';
    ctx.fillText(this._truncateText(ctx, this._track?.artist || 'Unknown Zemari', 640), 320, 212);

    // Divider line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(128, 336);
    ctx.lineTo(w - 128, 336);
    ctx.stroke();

    // Opening Quote Accent
    ctx.fillStyle = c1;
    ctx.font = 'bold 92px Georgia, serif';
    ctx.fillText('“', 124, 368);

    // Lyrics block
    const quoteLines = this._getSelectedLinesText();
    const maxTextWidth = w - 256;
    const fontSize = quoteLines.length >= 4 ? 48 : (quoteLines.length === 3 ? 54 : 62);
    const lineHeight = Math.round(fontSize * 1.42);
    ctx.font = `bold ${fontSize}px "Abyssinica SIL", "Noto Sans Ethiopic", "Segoe UI", sans-serif`;

    const wrapped = [];
    quoteLines.forEach((raw) => {
      const words = raw.split(/\s+/);
      let current = '';
      for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        if (ctx.measureText(test).width > maxTextWidth && current) {
          wrapped.push(current);
          current = word;
        } else {
          current = test;
        }
      }
      if (current) wrapped.push(current);
    });

    const maxVisible = 10;
    const visible = wrapped.slice(0, maxVisible);
    const totalH = visible.length * lineHeight;
    let startY = Math.max(460, Math.round((h - 190 + 360 - totalH) / 2));

    ctx.fillStyle = '#ffffff';
    visible.forEach((ln) => {
      ctx.fillText(ln, 128, startY);
      startY += lineHeight;
    });

    // Footer watermark
    ctx.fillStyle = 'rgba(229, 185, 90, 0.92)';
    ctx.font = '700 26px "Segoe UI", sans-serif';
    ctx.fillText('ELM • ETHIO LYRICS MEDIA', 128, h - 156);
    ctx.fillStyle = 'rgba(203, 213, 225, 0.58)';
    ctx.font = '500 22px "Segoe UI", sans-serif';
    ctx.fillText(this._track?.album && this._track.album !== 'Single' ? this._track.album : 'Synced Lyrics Stage', 128, h - 120);
  }

  _roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  _truncateText(ctx, text, maxW) {
    if (!text) return '';
    if (ctx.measureText(text).width <= maxW) return text;
    let out = text;
    while (out.length > 1 && ctx.measureText(out + '...').width > maxW) {
      out = out.slice(0, -1);
    }
    return out + '...';
  }

  async _getPngBlob() {
    const canvas = this._overlay?.querySelector('#elmSharePreviewCanvas');
    if (!canvas) return null;
    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
  }

  async _downloadPng() {
    const blob = await this._getPngBlob();
    if (!blob) return;
    const slug = (this._track?.title || 'lyric-card').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'elm-card';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `elm-${slug}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this._notify('Lyric card saved as PNG');
  }

  async _nativeShare() {
    const blob = await this._getPngBlob();
    const text = `${this._getSelectedLinesText().join('\n')}\n— ${this._track?.title || ''} (${this._track?.artist || ''})`;
    if (blob && typeof navigator !== 'undefined' && navigator.share && navigator.canShare) {
      try {
        const file = new File([blob], 'elm-lyric-card.png', { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ title: this._track?.title || 'ELM Lyric Card', text, files: [file] });
          return;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    await this._downloadPng();
  }

  async _copyQuoteText() {
    const quote = `${this._getSelectedLinesText().join('\n')}\n— ${this._track?.title || ''} (${this._track?.artist || ''})`;
    try {
      await navigator.clipboard.writeText(quote);
      this._notify('Lyric quote copied to clipboard');
    } catch {
      this._notify('Copy unavailable on this browser');
    }
  }
}

export const LyricShareCard = new LyricShareCardManager();
