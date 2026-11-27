import { escapeHtml } from '../utils/sanitize.js';

/**
 * Reusable in-app modal dialog system replacing native alert(), confirm(), and prompt().
 */
class AppDialogManager {
  constructor() {
    this._overlay = null;
    this._resolver = null;
    this._mode = 'alert';
    this._keyHandler = this._onKeyDown.bind(this);
  }

  _ensureDom() {
    if (this._overlay || typeof document === 'undefined') return;
    const overlay = document.createElement('div');
    overlay.id = 'elmAppDialogOverlay';
    overlay.className = 'modal-overlay app-dialog-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'elmAppDialogTitle');
    overlay.innerHTML = `
      <div class="modal-card app-dialog-card">
        <div class="modal-header app-dialog-header">
          <div style="display:flex; align-items:center; gap:0.6rem; min-width:0;">
            <span id="elmAppDialogIcon" class="app-dialog-icon" aria-hidden="true"></span>
            <h2 id="elmAppDialogTitle" class="app-dialog-title">Notice</h2>
          </div>
          <button type="button" class="modal-close-btn" id="elmAppDialogClose" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body app-dialog-body">
          <p id="elmAppDialogMessage" class="app-dialog-message"></p>
          <pre id="elmAppDialogPre" class="app-dialog-pre" style="display:none;"></pre>
          <div id="elmAppDialogInputWrap" style="display:none;">
            <input type="text" id="elmAppDialogInput" class="form-input app-dialog-input" autocomplete="off">
          </div>
          <div id="elmAppDialogChoices" class="app-dialog-choices" style="display:none;"></div>
        </div>
        <div id="elmAppDialogFooter" class="app-dialog-footer">
          <button type="button" id="elmAppDialogCancel" class="btn-pill app-dialog-cancel">Cancel</button>
          <button type="button" id="elmAppDialogConfirm" class="btn-primary app-dialog-confirm">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this._overlay = overlay;

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this._finish(this._cancelValue());
    });
    overlay.querySelector('#elmAppDialogClose').addEventListener('click', () => {
      this._finish(this._cancelValue());
    });
    overlay.querySelector('#elmAppDialogCancel').addEventListener('click', () => {
      this._finish(this._cancelValue());
    });
    overlay.querySelector('#elmAppDialogConfirm').addEventListener('click', () => {
      this._finish(this._confirmValue());
    });
    overlay.querySelector('#elmAppDialogInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._finish(this._confirmValue());
      }
    });
  }

  _cancelValue() {
    if (this._mode === 'confirm') return false;
    if (this._mode === 'prompt' || this._mode === 'choose') return null;
    return undefined;
  }

  _confirmValue() {
    if (this._mode === 'confirm') return true;
    if (this._mode === 'prompt') {
      const input = this._overlay?.querySelector('#elmAppDialogInput');
      return input ? input.value : '';
    }
    return undefined;
  }

  _onKeyDown(e) {
    if (!this._overlay || !this._overlay.classList.contains('active')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this._finish(this._cancelValue());
    }
  }

  _finish(val) {
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', this._keyHandler, true);
    }
    if (this._overlay) {
      this._overlay.classList.remove('active');
    }
    const resolver = this._resolver;
    this._resolver = null;
    if (resolver) resolver(val);
  }

  _open({
    mode = 'alert',
    title = 'Notice',
    message = '',
    preText = '',
    confirmText = 'OK',
    cancelText = 'Cancel',
    danger = false,
    placeholder = '',
    defaultValue = '',
    readOnly = false,
    choices = null
  }) {
    if (typeof document === 'undefined') {
      return Promise.resolve(mode === 'confirm' ? false : null);
    }
    if (this._resolver) {
      this._finish(this._cancelValue());
    }
    this._ensureDom();
    this._mode = mode;

    const iconEl = this._overlay.querySelector('#elmAppDialogIcon');
    const titleEl = this._overlay.querySelector('#elmAppDialogTitle');
    const msgEl = this._overlay.querySelector('#elmAppDialogMessage');
    const preEl = this._overlay.querySelector('#elmAppDialogPre');
    const inputWrap = this._overlay.querySelector('#elmAppDialogInputWrap');
    const inputEl = this._overlay.querySelector('#elmAppDialogInput');
    const choicesEl = this._overlay.querySelector('#elmAppDialogChoices');
    const footerEl = this._overlay.querySelector('#elmAppDialogFooter');
    const cancelBtn = this._overlay.querySelector('#elmAppDialogCancel');
    const confirmBtn = this._overlay.querySelector('#elmAppDialogConfirm');

    if (danger) {
      iconEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    } else {
      iconEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-gold, #e5b95a)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
    }

    titleEl.textContent = title || 'Notice';
    msgEl.textContent = message || '';
    msgEl.style.display = message ? 'block' : 'none';

    if (preText) {
      preEl.textContent = preText;
      preEl.style.display = 'block';
    } else {
      preEl.textContent = '';
      preEl.style.display = 'none';
    }

    if (mode === 'prompt') {
      inputWrap.style.display = 'block';
      inputEl.value = defaultValue || '';
      inputEl.placeholder = placeholder || '';
      inputEl.readOnly = Boolean(readOnly);
    } else {
      inputWrap.style.display = 'none';
      inputEl.value = '';
      inputEl.readOnly = false;
    }

    if (mode === 'choose' && Array.isArray(choices)) {
      choicesEl.innerHTML = '';
      choicesEl.style.display = 'flex';
      for (const opt of choices) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `app-dialog-choice-btn ${opt.danger ? 'is-danger' : ''} ${opt.primary ? 'is-primary' : ''}`;
        btn.innerHTML = `
          <span class="app-dialog-choice-label">${escapeHtml(opt.label || '')}</span>
          ${opt.sublabel ? `<span class="app-dialog-choice-sub">${escapeHtml(opt.sublabel)}</span>` : ''}
        `;
        btn.addEventListener('click', () => this._finish(opt.id));
        choicesEl.appendChild(btn);
      }
      footerEl.style.display = 'flex';
      cancelBtn.style.display = 'inline-flex';
      cancelBtn.textContent = cancelText || 'Cancel';
      confirmBtn.style.display = 'none';
    } else {
      choicesEl.innerHTML = '';
      choicesEl.style.display = 'none';
      footerEl.style.display = 'flex';
      cancelBtn.style.display = (mode === 'alert') ? 'none' : 'inline-flex';
      cancelBtn.textContent = cancelText || 'Cancel';
      confirmBtn.style.display = 'inline-flex';
      confirmBtn.textContent = confirmText || 'OK';
      confirmBtn.classList.toggle('is-danger', Boolean(danger));
    }

    this._overlay.classList.add('active');
    document.addEventListener('keydown', this._keyHandler, true);

    requestAnimationFrame(() => {
      if (mode === 'prompt') {
        inputEl.focus();
        inputEl.select();
      } else if (mode === 'choose') {
        choicesEl.querySelector('button')?.focus();
      } else {
        confirmBtn.focus();
      }
    });

    return new Promise((resolve) => {
      this._resolver = resolve;
    });
  }

  alert({ title = 'Notice', message = '', preText = '', okText = 'OK' } = {}) {
    return this._open({ mode: 'alert', title, message, preText, confirmText: okText });
  }

  confirm({ title = 'Confirm Action', message = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
    return this._open({ mode: 'confirm', title, message, confirmText, cancelText, danger });
  }

  prompt({ title = 'Enter Details', message = '', placeholder = '', defaultValue = '', confirmText = 'Save', cancelText = 'Cancel', readOnly = false } = {}) {
    return this._open({ mode: 'prompt', title, message, placeholder, defaultValue, confirmText, cancelText, readOnly });
  }

  choose({ title = 'Choose Option', message = '', choices = [], cancelText = 'Cancel' } = {}) {
    return this._open({ mode: 'choose', title, message, choices, cancelText });
  }
}

export const AppDialog = new AppDialogManager();
