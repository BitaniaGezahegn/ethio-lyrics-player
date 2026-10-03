/**
 * Ambient Particles Engine
 * Renders very subtle, elegant floating dust motes / snowflakes that catch the ambient light.
 * Highly optimized for 60 FPS with minimal GPU & CPU overhead (~25 particles).
 */
export class AmbientParticles {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    if (!this.canvas) return;

    this.ctx = this.canvas.getContext('2d');
    this.particles = [];
    this.numParticles = 28;
    this.isRunning = false;
    this.rafId = null;

    this.init();
  }

  init() {
    this.resize();
    window.addEventListener('resize', () => this.resize());

    // Generate particles
    this.particles = [];
    for (let i = 0; i < this.numParticles; i++) {
      this.particles.push(this.createParticle(true));
    }

    // Pause when page is hidden to preserve battery
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stop();
      } else {
        this.start();
      }
    });

    this.start();
  }

  resize() {
    if (!this.canvas) return;
    this.width = this.canvas.width = this.canvas.offsetWidth || window.innerWidth;
    this.height = this.canvas.height = this.canvas.offsetHeight || window.innerHeight;
  }

  createParticle(randomY = false) {
    return {
      x: Math.random() * (this.width || 1000),
      y: randomY ? Math.random() * (this.height || 800) : -10,
      radius: Math.random() * 1.5 + 0.6, // tiny dust / snow speck
      baseOpacity: Math.random() * 0.28 + 0.12, // subtle, non-intrusive
      vy: Math.random() * 0.35 + 0.15, // gentle slow fall
      vx: (Math.random() - 0.5) * 0.2, // subtle horizontal drift
      sway: Math.random() * Math.PI * 2,
      swaySpeed: Math.random() * 0.015 + 0.008
    };
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.loop();
  }

  stop() {
    this.isRunning = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  loop() {
    if (!this.isRunning) return;

    this.ctx.clearRect(0, 0, this.width, this.height);

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];

      p.sway += p.swaySpeed;
      p.y += p.vy;
      p.x += p.vx + Math.sin(p.sway) * 0.25;

      // Wrap-around
      if (p.y > this.height + 15) {
        p.y = -10;
        p.x = Math.random() * this.width;
      }
      if (p.x < -15) p.x = this.width + 10;
      if (p.x > this.width + 15) p.x = -10;

      // Draw subtle particle
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      this.ctx.fillStyle = `rgba(255, 255, 255, ${p.baseOpacity})`;
      this.ctx.fill();
    }

    this.rafId = requestAnimationFrame(() => this.loop());
  }
}
