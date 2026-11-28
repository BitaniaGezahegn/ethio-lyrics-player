import { escapeHtml, sanitizeUrl } from '../utils/sanitize.js';

/**
 * Single shared track context/overflow action menu.
 * Renders as a positioned popover on desktop and a bottom action sheet on mobile.
 */
class TrackActionMenuManager {
  constructor() {
    this._backdrop = null;
    this._menu = null;
    this._onAction = null;
    this._currentTrack = null;
    this._escapeHandler = (e) => {
      if (e.key === 'Escape' && this.isOpen()) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
    this._scrollCloseHandler = () => {
      if (this.isOpen() && typeof window !== 'undefined' && window.innerWidth > 820) {
        this.close();
      }
    };
  }

  _ensureDom() {
    if (this._backdrop || typeof document === 'undefined') return;

    const backdrop = document.createElement('div');
    backdrop.className = 'track-menu-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');

    const menu = document.createElement('div');
    menu.className = 'track-menu-surface';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Track actions');

    backdrop.appendChild(menu);
    document.body.appendChild(backdrop);

    this._backdrop = backdrop;
    this._menu = menu;

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.close();
    });

    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-track-action]');
      if (!btn) return;
      e.stopPropagation();
      const action = btn.dataset.trackAction;
      const track = this._currentTrack;
      const handler = this._onAction;
      this.close();
      if (handler && track) {
        handler(action, track);
      }
    });
  }

  isOpen() {
    return Boolean(this._backdrop && this._backdrop.classList.contains('active'));
  }

  close() {
    if (!this._backdrop) return;
    this._backdrop.classList.remove('active');
    this._menu.classList.remove('is-sheet', 'is-popover');
    this._currentTrack = null;
    this._onAction = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', this._escapeHandler, true);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this._scrollCloseHandler);
    }
  }

  /**
   * Open the track action menu.
   * @param {{
   *   track: object,
   *   anchorEl?: HTMLElement | null,
   *   clientX?: number,
   *   clientY?: number,
   *   isFavorite?: boolean,
   *   isOfflineSaved?: boolean,
   *   canSaveOffline?: boolean,
   *   canDelete?: boolean,
   *   canEdit?: boolean,
   *   onAction: (action: string, track: object) => void
   * }} opts
   */
  open(opts = {}) {
    if (typeof document === 'undefined' || !opts.track) return;
    this._ensureDom();

    const {
      track,
      anchorEl = null,
      clientX = null,
      clientY = null,
      isFavorite = false,
      isOfflineSaved = false,
      canSaveOffline = true,
      canDelete = false,
      canEdit = true,
      onAction = null
    } = opts;

    this._currentTrack = track;
    this._onAction = onAction;

    const coverUrl = sanitizeUrl(track.cover, 'brand/elm-default-cover.svg') || 'brand/elm-default-cover.svg';
    const items = [
      { id: 'play-next', label: 'Play Next', icon: 'next' },
      { id: 'add-queue', label: 'Add to Queue', icon: 'queue' },
      { id: 'add-playlist', label: 'Add to Playlist', icon: 'playlist' },
      {
        id: 'toggle-favorite',
        label: isFavorite ? 'Remove from Favorites' : 'Add to Favorites',
        icon: isFavorite ? 'heart-filled' : 'heart'
      }
    ];

    if (canSaveOffline) {
      items.push({
        id: 'toggle-offline',
        label: isOfflineSaved ? 'Remove Offline Download' : 'Save for Offline',
        icon: isOfflineSaved ? 'offline-done' : 'offline'
      });
    }

    items.push(
      { id: 'open-lyrics', label: 'Open Lyrics Stage', icon: 'lyrics' },
      { id: 'song-details', label: 'Mezmur Details & Credits', icon: 'info' }
    );

    if (canEdit) {
      items.push({ id: 'edit-song', label: 'Suggest Mezmur Edit', icon: 'edit' });
    }

    if (canDelete) {
      items.push({ id: 'delete-track', label: 'Delete Mezmur', icon: 'trash', danger: true });
    }

    this._menu.innerHTML = `
      <div class="track-menu-header">
        <img class="track-menu-cover" src="${escapeHtml(coverUrl)}" alt="" onerror="this.src='brand/elm-default-cover.svg'">
        <div class="track-menu-meta">
          <div class="track-menu-title">${escapeHtml(track.title || 'Untitled')}</div>
          <div class="track-menu-artist">${escapeHtml(track.artist || 'Unknown Zemari')}</div>
        </div>
        <button type="button" class="track-menu-close" aria-label="Close menu">&times;</button>
      </div>
      <div class="track-menu-items">
        ${items.map((item) => `
          <button type="button" role="menuitem" class="track-menu-item ${item.danger ? 'is-danger' : ''}" data-track-action="${item.id}">
            <span class="track-menu-icon">${this._renderIcon(item.icon)}</span>
            <span>${escapeHtml(item.label)}</span>
          </button>
        `).join('')}
      </div>
    `;

    this._menu.querySelector('.track-menu-close')?.addEventListener('click', () => this.close());

    const isMobile = typeof window !== 'undefined' && window.innerWidth <= 820;
    this._menu.classList.toggle('is-sheet', isMobile);
    this._menu.classList.toggle('is-popover', !isMobile);

    this._backdrop.classList.add('active');

    if (isMobile) {
      this._menu.style.left = '';
      this._menu.style.top = '';
    } else {
      this._positionPopover(anchorEl, clientX, clientY);
    }

    document.addEventListener('keydown', this._escapeHandler, true);
    window.addEventListener('resize', this._scrollCloseHandler);
  }

  _positionPopover(anchorEl, clientX, clientY) {
    const pad = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const menuRect = this._menu.getBoundingClientRect();
    const mw = menuRect.width || 248;
    const mh = menuRect.height || 340;

    let left = 0;
    let top = 0;

    if (Number.isFinite(clientX) && Number.isFinite(clientY) && clientX > 0 && clientY > 0 && !anchorEl) {
      left = clientX;
      top = clientY;
    } else if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      left = rect.right - mw;
      top = rect.bottom + 6;
      if (left < pad) left = rect.left;
    } else {
      left = (vw - mw) / 2;
      top = (vh - mh) / 2;
    }

    if (left + mw > vw - pad) left = vw - mw - pad;
    if (left < pad) left = pad;
    if (top + mh > vh - pad) top = Math.max(pad, vh - mh - pad);
    if (top < pad) top = pad;

    this._menu.style.left = `${Math.round(left)}px`;
    this._menu.style.top = `${Math.round(top)}px`;
  }

  _renderIcon(name) {
    const svgStart = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
    switch (name) {
      case 'next':
        return `${svgStart}<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>`;
      case 'queue':
        return `${svgStart}<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
      case 'playlist':
        return `${svgStart}<path d="M12 5v14"/><path d="M5 12h14"/></svg>`;
      case 'heart-filled':
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
      case 'heart':
        return `${svgStart}<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
      case 'offline-done':
        return `${svgStart}<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
      case 'offline':
        return `${svgStart}<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
      case 'lyrics':
        return `${svgStart}<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
      case 'info':
        return `${svgStart}<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
      case 'edit':
        return `${svgStart}<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
      case 'trash':
        return `${svgStart}<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
      default:
        return `${svgStart}<circle cx="12" cy="12" r="1"/></svg>`;
    }
  }
}

export const TrackActionMenu = new TrackActionMenuManager();
