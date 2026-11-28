/**
 * Custom Glassmorphic Dropdown System (replaces native <select> popups).
 * Enhances any <select> element while keeping its DOM value & 'change' events intact.
 */
class CustomDropdownManager {
  constructor() {
    this._instances = new WeakMap();
    this._allSelects = new Set();
    this._activeMenu = null;
    this._activeInstance = null;

    this._onDocPointerDown = (e) => {
      if (!this._activeInstance) return;
      const { wrapper } = this._activeInstance;
      if (this._activeMenu && this._activeMenu.contains(e.target)) return;
      if (wrapper && wrapper.contains(e.target)) return;
      this.closeActive();
    };

    this._onKeyDown = (e) => {
      if (!this._activeInstance || !this._activeMenu) return;
      const options = [...this._activeMenu.querySelectorAll('.elm-dropdown-option:not([disabled])')];
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const trigger = this._activeInstance.trigger;
        this.closeActive();
        trigger?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (options.length === 0) return;
        const curIdx = options.indexOf(document.activeElement);
        const nextIdx = e.key === 'ArrowDown'
          ? (curIdx + 1) % options.length
          : (curIdx - 1 + options.length) % options.length;
        options[nextIdx].focus();
      } else if (e.key === 'Enter' && document.activeElement?.classList.contains('elm-dropdown-option')) {
        e.preventDefault();
        document.activeElement.click();
      }
    };

    this._onWindowReposition = () => {
      if (this._activeInstance) {
        this._positionMenu(this._activeInstance);
      }
    };
  }

  enhanceAll(root = document) {
    if (typeof document === 'undefined') return;
    root.querySelectorAll('select').forEach((sel) => this.enhance(sel));
  }

  enhance(selectEl, opts = {}) {
    if (!selectEl || typeof document === 'undefined') return null;
    if (this._instances.has(selectEl)) {
      this.sync(selectEl);
      return this._instances.get(selectEl);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'elm-dropdown';
    if (opts.compact || selectEl.classList.contains('catalog-sort-select') || selectEl.classList.contains('settings-compact-select') || selectEl.classList.contains('settings-pref-select') || selectEl.classList.contains('home-filter-select')) {
      wrapper.classList.add('is-compact');
    }
    if (selectEl.classList.contains('home-filter-select')) {
      wrapper.classList.add('is-filter-pill');
    }

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'elm-dropdown-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    if (selectEl.title) trigger.title = selectEl.title;
    if (selectEl.getAttribute('aria-label')) {
      trigger.setAttribute('aria-label', selectEl.getAttribute('aria-label'));
    }

    const iconSlot = document.createElement('span');
    iconSlot.className = 'elm-dropdown-icon';
    const iconHtml = opts.iconHtml || selectEl.dataset.dropdownIcon || '';
    if (iconHtml) {
      iconSlot.innerHTML = iconHtml;
    } else {
      iconSlot.style.display = 'none';
    }

    const labelSpan = document.createElement('span');
    labelSpan.className = 'elm-dropdown-label';

    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('class', 'elm-dropdown-chevron');
    chevron.setAttribute('width', '14');
    chevron.setAttribute('height', '14');
    chevron.setAttribute('viewBox', '0 0 24 24');
    chevron.setAttribute('fill', 'none');
    chevron.setAttribute('stroke', 'currentColor');
    chevron.setAttribute('stroke-width', '2.2');
    chevron.setAttribute('stroke-linecap', 'round');
    chevron.setAttribute('stroke-linejoin', 'round');
    chevron.innerHTML = '<polyline points="6 9 12 15 18 9"></polyline>';

    trigger.appendChild(iconSlot);
    trigger.appendChild(labelSpan);
    trigger.appendChild(chevron);

    // Insert wrapper where selectEl sits and move selectEl inside hidden
    selectEl.parentNode.insertBefore(wrapper, selectEl);
    selectEl.classList.add('elm-native-select-hidden');
    selectEl.setAttribute('tabindex', '-1');
    selectEl.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(selectEl);
    wrapper.appendChild(trigger);

    const instance = {
      selectEl,
      wrapper,
      trigger,
      labelSpan,
      iconSlot,
      align: opts.align || selectEl.dataset.dropdownAlign || 'auto'
    };

    this._instances.set(selectEl, instance);
    this._allSelects.add(selectEl);

    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this._activeInstance === instance) {
        this.closeActive();
      } else {
        this.open(instance);
      }
    });

    selectEl.addEventListener('change', () => {
      this.sync(selectEl);
    });

    // Watch dynamic option additions/removals (e.g., Artist & Album pickers)
    if (typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(() => this.sync(selectEl));
      mo.observe(selectEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label'] });
      instance.observer = mo;
    }

    this.sync(selectEl);
    return instance;
  }

  sync(selectEl) {
    if (!selectEl) return;
    const instance = this._instances.get(selectEl);
    if (!instance) return;
    const selectedOpt = selectEl.options[selectEl.selectedIndex] || selectEl.options[0];
    const text = selectedOpt ? selectedOpt.textContent.trim() : 'Select...';
    instance.labelSpan.textContent = text;
    instance.trigger.disabled = Boolean(selectEl.disabled);

    if (this._activeInstance === instance && this._activeMenu) {
      this._renderMenuOptions(instance);
    }
  }

  syncAll() {
    this._allSelects.forEach((sel) => this.sync(sel));
  }

  open(instance) {
    this.closeActive();
    if (!instance || instance.selectEl.disabled) return;

    const menu = document.createElement('div');
    menu.className = 'elm-dropdown-menu';
    menu.setAttribute('role', 'listbox');
    document.body.appendChild(menu);

    this._activeMenu = menu;
    this._activeInstance = instance;
    instance.wrapper.classList.add('is-open');
    instance.trigger.setAttribute('aria-expanded', 'true');

    this._renderMenuOptions(instance);
    this._positionMenu(instance);

    requestAnimationFrame(() => {
      menu.classList.add('is-visible');
      const selectedBtn = menu.querySelector('.elm-dropdown-option.is-selected');
      if (selectedBtn) {
        selectedBtn.scrollIntoView({ block: 'nearest' });
      }
    });

    document.addEventListener('pointerdown', this._onDocPointerDown, true);
    document.addEventListener('keydown', this._onKeyDown, true);
    window.addEventListener('resize', this._onWindowReposition);
    window.addEventListener('scroll', this._onWindowReposition, true);
  }

  _renderMenuOptions(instance) {
    const menu = this._activeMenu;
    const { selectEl } = instance;
    if (!menu || !selectEl) return;

    menu.innerHTML = '';
    const currentValue = selectEl.value;
    const opts = [...selectEl.options];

    opts.forEach((opt, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'elm-dropdown-option';
      btn.setAttribute('role', 'option');
      const isSelected = opt.value === currentValue && (opt.selected || idx === selectEl.selectedIndex);
      if (isSelected) {
        btn.classList.add('is-selected');
        btn.setAttribute('aria-selected', 'true');
      } else {
        btn.setAttribute('aria-selected', 'false');
      }
      if (opt.disabled) {
        btn.disabled = true;
      }

      const textSpan = document.createElement('span');
      textSpan.className = 'elm-dropdown-option-label';
      textSpan.textContent = opt.textContent.trim();

      const checkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      checkSvg.setAttribute('class', 'elm-dropdown-check');
      checkSvg.setAttribute('width', '14');
      checkSvg.setAttribute('height', '14');
      checkSvg.setAttribute('viewBox', '0 0 24 24');
      checkSvg.setAttribute('fill', 'none');
      checkSvg.setAttribute('stroke', 'currentColor');
      checkSvg.setAttribute('stroke-width', '2.5');
      checkSvg.setAttribute('stroke-linecap', 'round');
      checkSvg.setAttribute('stroke-linejoin', 'round');
      checkSvg.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';

      btn.appendChild(textSpan);
      btn.appendChild(checkSvg);

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (opt.disabled) return;
        const changed = selectEl.value !== opt.value || selectEl.selectedIndex !== idx;
        selectEl.selectedIndex = idx;
        selectEl.value = opt.value;
        this.sync(selectEl);
        this.closeActive();
        if (changed) {
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      menu.appendChild(btn);
    });
  }

  _positionMenu(instance) {
    const menu = this._activeMenu;
    if (!menu || !instance?.trigger) return;

    const rect = instance.trigger.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 10;

    const minWidth = Math.max(rect.width, 190);
    const maxWidth = Math.min(340, vw - pad * 2);
    menu.style.minWidth = `${Math.min(minWidth, maxWidth)}px`;
    menu.style.maxWidth = `${maxWidth}px`;

    const menuHeight = Math.min(menu.scrollHeight || 240, Math.min(290, vh * 0.48));
    const spaceBelow = vh - rect.bottom - pad;
    const spaceAbove = rect.top - pad;

    let top;
    if (spaceBelow >= menuHeight || spaceBelow >= spaceAbove) {
      top = Math.min(vh - menuHeight - pad, rect.bottom + 6);
      menu.classList.remove('opens-up');
    } else {
      top = Math.max(pad, rect.top - menuHeight - 6);
      menu.classList.add('opens-up');
    }

    const menuWidth = Math.max(menu.offsetWidth || minWidth, rect.width);
    let left = rect.left;
    if (instance.align === 'right' || rect.left + menuWidth > vw - pad) {
      left = Math.max(pad, rect.right - menuWidth);
    }
    if (left + menuWidth > vw - pad) {
      left = Math.max(pad, vw - menuWidth - pad);
    }

    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
  }

  closeActive() {
    if (this._activeInstance) {
      this._activeInstance.wrapper.classList.remove('is-open');
      this._activeInstance.trigger.setAttribute('aria-expanded', 'false');
    }
    if (this._activeMenu) {
      this._activeMenu.remove();
    }
    this._activeMenu = null;
    this._activeInstance = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerdown', this._onDocPointerDown, true);
      document.removeEventListener('keydown', this._onKeyDown, true);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this._onWindowReposition);
      window.removeEventListener('scroll', this._onWindowReposition, true);
    }
  }
}

export const CustomDropdown = new CustomDropdownManager();
