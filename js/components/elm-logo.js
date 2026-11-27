/**
 * Reusable ELM Brand Logo Component (Icon, Horizontal, Stacked)
 *
 * Uses `currentColor` for outer waveform/Meskel bars and wordmark text so it
 * adapts cleanly to both dark/Dynamic Ambient and light surfaces, while keeping
 * the center Tilet acoustic knot in `var(--elm-gold, #C4A259)`.
 *
 * Supports:
 * - Declarative `<elm-logo variant="icon|horizontal|stacked" animated></elm-logo>`
 * - Imperative `createElmLogo({ variant, className, animated })`
 * - String helper `renderElmLogoSvg({ variant, className, animated })`
 */

const ICON_MARK_INNER = `
  <g class="elm-logo-bars" fill="currentColor">
    <!-- Top 5 Vertical Bars -->
    <rect class="elm-bar elm-bar-v" style="--elm-bar-i:0" x="66" y="24" width="7.5" height="34" />
    <rect class="elm-bar elm-bar-v" style="--elm-bar-i:1" x="81.125" y="16" width="7.5" height="42" />
    <rect class="elm-bar elm-bar-v" style="--elm-bar-i:2" x="96.25" y="4" width="7.5" height="54" />
    <rect class="elm-bar elm-bar-v" style="--elm-bar-i:3" x="111.375" y="16" width="7.5" height="42" />
    <rect class="elm-bar elm-bar-v" style="--elm-bar-i:4" x="126.5" y="24" width="7.5" height="34" />

    <!-- Bottom 5 Vertical Bars -->
    <rect class="elm-bar elm-bar-v" style="--elm-bar-i:4" x="66" y="142" width="7.5" height="34" />
    <rect class="elm-bar elm-bar-v" style="--elm-bar-i:3" x="81.125" y="142" width="7.5" height="42" />
    <rect class="elm-bar elm-bar-v" style="--elm-bar-i:2" x="96.25" y="142" width="7.5" height="54" />
    <rect class="elm-bar elm-bar-v" style="--elm-bar-i:1" x="111.375" y="142" width="7.5" height="42" />
    <rect class="elm-bar elm-bar-v" style="--elm-bar-i:0" x="126.5" y="142" width="7.5" height="34" />

    <!-- Left 4 Horizontal Bars -->
    <rect class="elm-bar elm-bar-h" style="--elm-bar-i:0" x="19" y="66" width="39" height="7.5" />
    <rect class="elm-bar elm-bar-h" style="--elm-bar-i:1" x="4" y="86.17" width="54" height="7.5" />
    <rect class="elm-bar elm-bar-h" style="--elm-bar-i:2" x="4" y="106.33" width="54" height="7.5" />
    <rect class="elm-bar elm-bar-h" style="--elm-bar-i:3" x="19" y="126.5" width="39" height="7.5" />

    <!-- Right 4 Horizontal Bars -->
    <rect class="elm-bar elm-bar-h" style="--elm-bar-i:3" x="142" y="66" width="39" height="7.5" />
    <rect class="elm-bar elm-bar-h" style="--elm-bar-i:2" x="142" y="86.17" width="54" height="7.5" />
    <rect class="elm-bar elm-bar-h" style="--elm-bar-i:1" x="142" y="106.33" width="54" height="7.5" />
    <rect class="elm-bar elm-bar-h" style="--elm-bar-i:0" x="142" y="126.5" width="39" height="7.5" />
  </g>

  <g class="elm-logo-knot" stroke="var(--elm-gold, #C4A259)" stroke-width="8.5" stroke-linecap="butt" stroke-linejoin="miter">
    <path d="M 66 70.25 H 92 L 113.5 91.75" />
    <path d="M 134 129.75 H 108 L 86.5 108.25" />
    <path d="M 129.75 66 V 92 L 108.25 113.5" />
    <path d="M 70.25 134 V 108 L 91.75 86.5" />
  </g>
  <rect class="elm-logo-knot-accent" x="66" y="86.17" width="8.5" height="8.5" fill="var(--elm-gold, #C4A259)" />
  <rect class="elm-logo-knot-accent" x="125.5" y="105.33" width="8.5" height="8.5" fill="var(--elm-gold, #C4A259)" />
`;

const VARIANT_CONFIG = {
  icon: {
    viewBox: '0 0 200 200',
    defaultLabel: 'ELM Logo',
    body: ICON_MARK_INNER,
  },
  horizontal: {
    viewBox: '0 0 260 80',
    defaultLabel: 'ELM — Ethio Lyrics Media',
    body: `
      <g transform="translate(4, 4) scale(0.36)">${ICON_MARK_INNER}</g>
      <text
        x="92"
        y="53"
        fill="currentColor"
        font-family="Inter, 'Segoe UI', system-ui, -apple-system, sans-serif"
        font-size="38"
        font-weight="800"
        letter-spacing="7"
      >ELM</text>
    `,
  },
  stacked: {
    viewBox: '0 0 240 280',
    defaultLabel: 'ELM — Ethio Lyrics Media',
    body: `
      <g transform="translate(20, 10)">${ICON_MARK_INNER}</g>
      <text
        x="120"
        y="258"
        text-anchor="middle"
        fill="currentColor"
        font-family="Inter, 'Segoe UI', system-ui, -apple-system, sans-serif"
        font-size="46"
        font-weight="800"
        letter-spacing="10"
      >ELM</text>
    `,
  },
};

/**
 * Render an inline ELM logo SVG markup string.
 * @param {object} [options]
 * @param {'icon'|'horizontal'|'stacked'} [options.variant='icon']
 * @param {string} [options.className='']
 * @param {boolean} [options.animated=false]
 * @param {string} [options.ariaLabel]
 * @returns {string}
 */
export function renderElmLogoSvg({ variant = 'icon', className = '', animated = false, ariaLabel } = {}) {
  const cfg = VARIANT_CONFIG[variant] || VARIANT_CONFIG.icon;
  const classes = [
    'elm-logo',
    `elm-logo--${variant in VARIANT_CONFIG ? variant : 'icon'}`,
    animated ? 'elm-logo--animated' : '',
    className,
  ].filter(Boolean).join(' ');

  const label = (ariaLabel || cfg.defaultLabel).replace(/"/g, '&quot;');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${cfg.viewBox}" fill="none" role="img" aria-label="${label}" class="${classes}">${cfg.body}</svg>`;
}

/**
 * Create a DOM SVG element for the ELM logo.
 * @param {object} [options]
 * @param {'icon'|'horizontal'|'stacked'} [options.variant='icon']
 * @param {string} [options.className='']
 * @param {boolean} [options.animated=false]
 * @param {string} [options.ariaLabel]
 * @returns {SVGElement}
 */
export function createElmLogo(options = {}) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderElmLogoSvg(options);
  return wrapper.firstElementChild;
}

if (typeof window !== 'undefined' && typeof HTMLElement !== 'undefined' && window.customElements) {
  class ElmLogoElement extends HTMLElement {
    static get observedAttributes() {
      return ['variant', 'animated', 'class', 'aria-label'];
    }

    connectedCallback() {
      this.render();
    }

    attributeChangedCallback() {
      if (this.isConnected) this.render();
    }

    render() {
      const variant = this.getAttribute('variant') || 'icon';
      const animated = this.hasAttribute('animated') && this.getAttribute('animated') !== 'false';
      const ariaLabel = this.getAttribute('aria-label') || undefined;
      this.innerHTML = renderElmLogoSvg({
        variant,
        animated,
        ariaLabel,
        className: 'elm-logo-svg',
      });
    }
  }

  if (!window.customElements.get('elm-logo')) {
    window.customElements.define('elm-logo', ElmLogoElement);
  }
}
