/**
 * Theme Manager: Handles modular themes and dynamic artwork atmosphere
 */
export const THEMES = [
  {
    id: 'theme-artwork-ambient',
    name: 'Dynamic Artwork Ambient (Default)',
    description: 'Living fluid ambient mesh dynamically extracted from the song artwork, featuring breathing background movement and floating dust/snow particles.',
    badge: 'Dynamic Art'
  },
  {
    id: 'theme-ethio-classic',
    name: '1999 Ethio Lyrics Video (Classic)',
    description: 'Authentic 1999 Ethiopian TV broadcast style: deep crimson vignette, Amharic dual header, broadcasting red beacon dot, and classic circular vinyl record.',
    badge: 'Classic 1999'
  },
  {
    id: 'theme-apple-kinetic',
    name: 'Apple Music Ambient Canvas',
    description: '3D physical album sleeve with vinyl record sliding out, fluid ambient gradient mesh, and Apple Music depth-of-field blur.',
    badge: 'Kinetic Glass'
  },
  {
    id: 'theme-cinema-horizon',
    name: 'Cinema Concert Horizon',
    description: '21:9 Widescreen theatrical concert stage with overhead spotlight beam, expansive typography, and golden karaoke light sweep.',
    badge: 'Cinematic'
  },
  {
    id: 'theme-karaoke-neon',
    name: 'Cyber Neon Club & Lounge',
    description: 'Cyberpunk nightclub stage with counter-rotating dual neon groove rings, electric cyan & magenta glow, and high-voltage pulses.',
    badge: 'Cyber Neon'
  }
];

export class ThemeManager {
  constructor(appElement) {
    this.appElement = appElement;
    this.currentTheme = localStorage.getItem('lyrics_app_theme') || 'theme-artwork-ambient';

    // Backwards compatibility alias for removed/legacy themes
    if (this.currentTheme === 'theme-tiktok-reels' || this.currentTheme === 'theme-spotify-modern') {
      this.currentTheme = 'theme-artwork-ambient';
    }

    this.onThemeChangeCallbacks = [];
  }

  init() {
    this.applyTheme(this.currentTheme);
  }

  applyTheme(themeId) {
    if (themeId === 'theme-tiktok-reels' || themeId === 'theme-spotify-modern') {
      themeId = 'theme-artwork-ambient';
    }

    // Remove existing theme classes
    THEMES.forEach(t => this.appElement.classList.remove(t.id));
    this.appElement.classList.remove('theme-tiktok-reels');
    this.appElement.classList.remove('theme-spotify-modern');

    // Find selected theme
    const selected = THEMES.find(t => t.id === themeId) || THEMES[0];
    this.currentTheme = selected.id;
    this.appElement.classList.add(selected.id);
    localStorage.setItem('lyrics_app_theme', selected.id);

    this.onThemeChangeCallbacks.forEach(cb => cb(selected));
  }

  onThemeChange(cb) {
    this.onThemeChangeCallbacks.push(cb);
  }

  getThemes() {
    return THEMES;
  }
}
