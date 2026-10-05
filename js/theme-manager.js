/**
 * Theme Manager: Handles modular themes and dynamic artwork atmosphere
 */
export const THEMES = [
  {
    id: 'theme-artwork-ambient',
    name: 'Dynamic Ambient',
    description: 'Living fluid ambient mesh dynamically extracted from song artwork with floating particles.',
    badge: 'Dynamic Art',
    previewGradient: 'linear-gradient(135deg, #e11d48, #2563eb, #0f172a)'
  },
  {
    id: 'theme-ethio-classic',
    name: '1999 Classic',
    description: 'Authentic 1999 Ethiopian TV broadcast style with deep crimson vignette and vinyl disc.',
    badge: 'Classic 1999',
    previewGradient: 'linear-gradient(135deg, #991b1b, #450a0a, #e5b95a)'
  },
  {
    id: 'theme-apple-kinetic',
    name: 'Kinetic Canvas',
    description: '3D physical album sleeve, fluid ambient gradient mesh, and Apple Music depth-of-field blur.',
    badge: 'Kinetic Glass',
    previewGradient: 'linear-gradient(135deg, #ec4899, #8b5cf6, #1e1b4b)'
  },
  {
    id: 'theme-cinema-horizon',
    name: 'Cinema Horizon',
    description: '21:9 Widescreen theatrical concert stage with golden spotlight beams and letterbox framing.',
    badge: 'Cinematic',
    previewGradient: 'linear-gradient(135deg, #ca8a04, #1c1917, #000000)'
  },
  {
    id: 'theme-karaoke-neon',
    name: 'Cyber Neon',
    description: 'Cyberpunk nightclub stage with electric cyan & magenta glow and counter-rotating rings.',
    badge: 'Cyber Neon',
    previewGradient: 'linear-gradient(135deg, #06b6d4, #d946ef, #020617)'
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

    // Ensure the saved theme is applied immediately on construction
    this.applyTheme(this.currentTheme);
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

