/**
 * Ambient Particles Engine
 * Renders subtle floating dust motes on the Lyrics stage.
 * Optimized for low-spec PCs: capped at ~24 FPS, DPR=1, paused when hidden,
 * paused when playback stops, and completely disabled in Lite mode.
 */
export class AmbientParticles {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    if (!this.canvas) return;

    this.ctx = this.canvas.getContext('2d', { alpha: true });
    this.particles = [];
    this.numParticles = 22;
    this.isRunning = false;
    this.enabled = true;
    this.stageActive = false;
    this.playing = false;
    this.rafId = null;
    this._lastFrameMs = 0;
    this._frameIntervalMs = 42; // ~24 FPS cap
    this._resizeTimer = null;

    this.init();
  }

  init() {
    this.resize();
    window.addEventListener('resize', () => {
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this.resize();
        if (this.enabled && this.stageActive && !this.isRunning) {
          this.renderStaticFrame();
        }
      }, 150);
    }, { passive: true });

    this.particles = [];
    for (let i = 0; i < this.numParticles; i++) {
      this.particles.push(this.createParticle(true));
    }

    document.addEventListener('visibilitychange', () => {
      this.syncState();
    });

    this.syncState();
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this.stop();
      this.clear();
    } else {
      this.syncState();
    }
  }

  setActiveContext({ isLyricsTab, isPlaying } = {}) {
    if (typeof isLyricsTab === 'boolean') this.stageActive = isLyricsTab;
    if (typeof isPlaying === 'boolean') this.playing = isPlaying;
    this.syncState();
  }

  syncState() {
    if (!this.canvas) return;
    if (!this.enabled || document.hidden || !this.stageActive) {
      this.stop();
      this.clear();
      return;
    }
    if (this.playing) {
      this.start();
    } else {
      this.stop();
      this.renderStaticFrame();
    }
  }

  resize() {
    if (!this.canvas) return;
    // Cap at 1x CSS pixels (no DPR scaling) to keep software rasterization cheap
    this.width = this.canvas.width = this.canvas.offsetWidth || window.innerWidth;
    this.height = this.canvas.height = this.canvas.offsetHeight || window.innerHeight;
  }

  clear() {
    if (!this.ctx || !this.canvas) return;
    this.ctx.clearRect(0, 0, this.width || this.canvas.width, this.height || this.canvas.height);
  }

  createParticle(randomY = false) {
    return {
      x: Math.random() * (this.width || 1000),
      y: randomY ? Math.random() * (this.height || 800) : -10,
      size: Math.random() * 1.8 + 1.2,
      bucket: Math.random() < 0.5 ? 0 : 1, // 2 opacity buckets to batch fillStyle changes
      vy: Math.random() * 0.65 + 0.3,
      vx: (Math.random() - 0.5) * 0.35,
      sway: Math.random() * Math.PI * 2,
      swaySpeed: Math.random() * 0.025 + 0.012
    };
  }

  start() {
    if (this.isRunning || !this.enabled || document.hidden || !this.stageActive) return;
    this.isRunning = true;
    this._lastFrameMs = 0;
    this.rafId = requestAnimationFrame((ts) => this.loop(ts));
  }

  stop() {
    this.isRunning = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  renderStaticFrame() {
    if (!this.ctx || !this.enabled || !this.stageActive) return;
    this.drawParticles(false);
  }

  drawParticles(advance) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);

    const styles = ['rgba(255, 255, 255, 0.16)', 'rgba(255, 255, 255, 0.30)'];
    for (let bucket = 0; bucket < 2; bucket++) {
      ctx.fillStyle = styles[bucket];
      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        if (advance && bucket === 0) {
          p.sway += p.swaySpeed;
          p.y += p.vy;
          p.x += p.vx + Math.sin(p.sway) * 0.35;
          if (p.y > h + 15) {
            p.y = -10;
            p.x = Math.random() * w;
          }
          if (p.x < -15) p.x = w + 10;
          else if (p.x > w + 15) p.x = -10;
        }
        if (p.bucket === bucket) {
          ctx.fillRect(p.x | 0, p.y | 0, p.size, p.size);
        }
      }
    }
  }

  loop(now) {
    if (!this.isRunning) return;
    if (!this._lastFrameMs || (now - this._lastFrameMs) >= this._frameIntervalMs) {
      this._lastFrameMs = now;
      this.drawParticles(true);
    }
    this.rafId = requestAnimationFrame((ts) => this.loop(ts));
  }
}
