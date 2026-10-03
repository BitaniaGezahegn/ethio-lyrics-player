/**
 * LRC Editor - Visual tap-sync authoring tool
 * Features:
 *  - Tab 1 (Import): Paste plain text lyrics or upload a .txt file
 *  - Tab 2 (Tap Sync): Play audio + press Space to stamp timestamps line-by-line
 *  - Tab 3 (Edit): Nudge individual timestamps, apply global offset, reorder lines
 *  - Tab 4 (Export): Preview LRC, copy to clipboard, download .lrc file
 */
export class LrcEditor {
  constructor(player, onSave) {
    this.player = player;
    this.onSave = onSave;
    this.lines = [];
    this.syncIndex = 0;
    this.isSyncing = false;
    this.globalOffset = 0;
    this._boundKeyHandler = this._onSyncKey.bind(this);
    this._buildDOM();
    this._bindEvents();
  }

  _buildDOM() {
    this.overlay = document.createElement('div');
    this.overlay.id = 'lrcEditorOverlay';
    this.overlay.className = 'modal-overlay';
    this.overlay.innerHTML = `
      <div class="modal-card lrc-editor-card">
        <div class="modal-header">
          <h2>&#127925; LRC Editor</h2>
          <button class="modal-close-btn" id="lrcEditorClose">&times;</button>
        </div>
        <div class="lrc-tab-nav">
          <button class="lrc-tab-btn active" data-tab="import">&#128221; Import Lyrics</button>
          <button class="lrc-tab-btn" data-tab="sync">&#127908; Tap Sync</button>
          <button class="lrc-tab-btn" data-tab="edit">&#9999;&#65039; Edit Timestamps</button>
          <button class="lrc-tab-btn" data-tab="export">&#11015;&#65039; Export</button>
        </div>
        <div class="lrc-tab-panels">
          <div class="lrc-panel active" data-panel="import">
            <p class="lrc-hint">Paste your lyrics below - one line per lyric. Plain text, no timestamps needed. You can also upload a <code>.txt</code> file.</p>
            <div style="display:flex; gap:0.5rem; margin-bottom:0.75rem;">
              <button class="btn-pill" id="lrcImportFilePick">&#128193; Upload .txt</button>
              <input type="file" id="lrcImportFileInput" accept=".txt,.lrc" style="display:none">
              <button class="btn-pill" id="lrcImportClear">&#128465; Clear</button>
            </div>
            <textarea id="lrcImportTextarea" class="form-textarea lrc-import-textarea" placeholder="Line 1&#10;Line 2&#10;Line 3&#10;..."></textarea>
            <div id="lrcHeaderNotice" class="lrc-header-notice" style="display:none; margin-top:0.6rem; padding:0.6rem 0.85rem; background:rgba(99,102,241,0.15); border:1px solid rgba(99,102,241,0.35); border-radius:10px; font-size:0.85rem; color:#e0e7ff;">
              <label style="display:flex; align-items:center; gap:0.6rem; cursor:pointer;">
                <input type="checkbox" id="lrcTreatAsIntro" checked style="width:16px; height:16px; cursor:pointer; accent-color:#6366f1;">
                <span><strong>🎵 Title Header Detected:</strong> <span id="lrcDetectedTitle" style="color:#fbbf24; font-weight:600;"></span><br>
                <span style="font-size:0.78rem; opacity:0.85;">Set as 0:00 Intro line so Tap Sync starts directly on the first sung lyric (prevents off-by-one delay).</span></span>
              </label>
            </div>
            <div style="display:flex; justify-content:flex-end; margin-top:0.75rem;">
              <button class="btn-primary" id="lrcImportCommit">Use These Lyrics &rarr;</button>
            </div>
          </div>
          <div class="lrc-panel" data-panel="sync">
            <div class="sync-instruction-pill" id="lrcSyncInstruction" style="text-align:center; padding:0.45rem 0.85rem; margin-bottom:0.5rem; background:rgba(255,255,255,0.06); border-radius:20px; font-size:0.85rem; color:#fff; border:1px solid rgba(255,255,255,0.1);">
              <span id="lrcSyncInstructionText">Press "Start Sync" to begin playback. Then tap <kbd>Enter</kbd> as each line begins.</span>
            </div>
            <div class="sync-mini-player">
              <button class="ctrl-btn sync-play-btn" id="lrcSyncPlayBtn" title="Play / Pause">
                <svg id="lrcSyncPlayIcon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                <svg id="lrcSyncPauseIcon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
              </button>
              <div class="sync-timeline-wrap">
                <span id="lrcSyncCurrentTime" class="time-label">0:00</span>
                <div class="scrubber-track" id="lrcSyncScrubber">
                  <div class="scrubber-fill" id="lrcSyncFill"><div class="scrubber-thumb"></div></div>
                </div>
                <span id="lrcSyncDuration" class="time-label">0:00</span>
              </div>
              <button class="ctrl-btn" id="lrcSyncRestart" title="Restart">&#8634;</button>
            </div>
            <div class="sync-progress-bar">
              <div id="lrcSyncProgressFill" style="width:0%"></div>
            </div>
            <div class="sync-lyric-display">
              <div class="sync-context-line sync-far-prev" id="lrcSyncFarPrevLine"></div>
              <div class="sync-context-line sync-prev-line" id="lrcSyncPrevLine"></div>
              <div class="sync-curr-line" id="lrcSyncCurrLine">Press "Start Sync" to begin</div>
              <div class="sync-context-line sync-next-line" id="lrcSyncNextLine1"></div>
              <div class="sync-context-line sync-far-next" id="lrcSyncNextLine2"></div>
              <div class="sync-context-line sync-far-next2" id="lrcSyncNextLine3"></div>
            </div>
            <div class="sync-controls">
              <button class="btn-primary" id="lrcSyncStartBtn">&#9654; Start Sync</button>
              <button class="btn-pill" id="lrcSyncTapBtn" disabled>&#9000; Tap / Enter</button>
              <button class="btn-pill" id="lrcSyncIntroBtn" title="Set current line as 0:00 Intro and advance to next line" disabled>🎵 0:00 Intro</button>
              <button class="btn-pill" id="lrcSyncUndoBtn" title="Undo last tap (Z)" disabled>&#8617; Undo</button>
              <button class="btn-pill" id="lrcSyncSkipBtn" title="Skip this line (S)" disabled>&#9197; Skip</button>
              <button class="btn-primary btn-save-lyrics" id="lrcSyncSaveBtn" title="Save timestamps and apply to current song">&#128190; Save &amp; Apply</button>
            </div>
            <div class="sync-status" id="lrcSyncStatus">0 / 0 lines stamped</div>
          </div>
          <div class="lrc-panel" data-panel="edit">
            <div class="edit-toolbar">
              <button class="btn-pill btn-shift-fix" id="lrcShiftUpBtn" title="Fix 1-line delay: Shift all timestamps up by 1 line and set line 1 to 0:00">⏮ Fix 1-Line Offset (Shift Up)</button>
              <button class="btn-pill" id="lrcShiftDownBtn" title="Shift all timestamps down by 1 line">⏭ Shift Down</button>
              <span style="opacity:0.3; margin:0 0.2rem;">|</span>
              <label>Global offset (ms):</label>
              <input type="number" id="lrcOffsetInput" class="form-input lrc-offset-input" value="0" step="100">
              <button class="btn-pill" id="lrcApplyOffset">Apply Offset</button>
              <span style="flex:1"></span>
              <button class="btn-pill" id="lrcEditAddLine">+ Add Line</button>
              <button class="btn-primary btn-save-lyrics" id="lrcEditSaveBtn" title="Save edited lyrics and apply to current song">&#128190; Save &amp; Apply</button>
            </div>
            <div class="lrc-lines-list" id="lrcLinesList"></div>
          </div>
          <div class="lrc-panel" data-panel="export">
            <div style="display:flex; gap:0.5rem; margin-bottom:0.75rem; flex-wrap:wrap;">
              <button class="btn-pill" id="lrcExportCopy">&#128203; Copy to Clipboard</button>
              <button class="btn-pill" id="lrcExportDownload">&#11015;&#65039; Download .lrc</button>
              <button class="btn-primary" id="lrcExportApply">&#9989; Apply to Current Song</button>
            </div>
            <textarea id="lrcExportPreview" class="form-textarea lrc-export-preview" readonly></textarea>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(this.overlay);
  }

  _bindEvents() {
    document.getElementById('lrcEditorClose').addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (e) => { if (e.target === this.overlay) this.close(); });

    this.overlay.querySelectorAll('.lrc-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this._switchTab(btn.dataset.tab));
    });

    // Real-time title header detection on Import textarea
    const checkHeader = () => {
      const raw = document.getElementById('lrcImportTextarea').value.trim();
      const firstLine = raw.split(/\r?\n/)[0]?.trim() || '';
      const isH = this._isHeader(firstLine);
      const notice = document.getElementById('lrcHeaderNotice');
      const detTitle = document.getElementById('lrcDetectedTitle');
      if (notice && detTitle) {
        if (isH && raw.split(/\r?\n/).filter(Boolean).length > 1) {
          detTitle.textContent = `"${firstLine}"`;
          notice.style.display = 'block';
        } else {
          notice.style.display = 'none';
        }
      }
    };
    document.getElementById('lrcImportTextarea').addEventListener('input', checkHeader);

    document.getElementById('lrcImportFilePick').addEventListener('click', () =>
      document.getElementById('lrcImportFileInput').click());
    document.getElementById('lrcImportFileInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        document.getElementById('lrcImportTextarea').value = evt.target.result;
        checkHeader();
      };
      reader.readAsText(file, 'utf-8');
    });
    document.getElementById('lrcImportClear').addEventListener('click', () => {
      document.getElementById('lrcImportTextarea').value = '';
      checkHeader();
    });
    document.getElementById('lrcImportCommit').addEventListener('click', () => this._commitImport());

    document.getElementById('lrcSyncPlayBtn').addEventListener('click', () => this.player.togglePlay());
    document.getElementById('lrcSyncRestart').addEventListener('click', () => this.player.seek(0));
    document.getElementById('lrcSyncScrubber').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this.player.seek(pos * this.player.duration);
    });
    document.getElementById('lrcSyncStartBtn').addEventListener('click', () => this._startSync());
    document.getElementById('lrcSyncTapBtn').addEventListener('click', () => this._tapTimestamp());
    document.getElementById('lrcSyncIntroBtn').addEventListener('click', () => this._markAsIntro());
    document.getElementById('lrcSyncUndoBtn').addEventListener('click', () => this._undoTap());
    document.getElementById('lrcSyncSkipBtn').addEventListener('click', () => this._skipLine());
    document.getElementById('lrcSyncSaveBtn').addEventListener('click', () => this._applyToSong());

    document.getElementById('lrcShiftUpBtn').addEventListener('click', () => this._shiftTimestampsUp());
    document.getElementById('lrcShiftDownBtn').addEventListener('click', () => this._shiftTimestampsDown());
    document.getElementById('lrcApplyOffset').addEventListener('click', () => this._applyOffset());
    document.getElementById('lrcEditAddLine').addEventListener('click', () => this._addEditLine());
    document.getElementById('lrcEditSaveBtn').addEventListener('click', () => this._applyToSong());

    document.getElementById('lrcExportCopy').addEventListener('click', () => this._copyToClipboard());
    document.getElementById('lrcExportDownload').addEventListener('click', () => this._downloadLrc());
    document.getElementById('lrcExportApply').addEventListener('click', () => this._applyToSong());
  }

  _isHeader(text) {
    if (!text || typeof text !== 'string') return false;
    const t = text.trim();
    if (/[-–—]/.test(t)) return true;
    if (/^(title|artist|track|song|album|ዘፈን|ድምፃዊ|አርቲስት)\s*[:：]/i.test(t)) return true;
    return false;
  }

  open(prefillLrc = '') {
    this._origTimeUpdate = this.player.onTimeUpdate;
    this._origStateChange = this.player.onStateChange;

    this.player.onTimeUpdate = (t, d) => {
      if (this._origTimeUpdate) this._origTimeUpdate(t, d);
      this._updateSyncTimeline(t, d);
    };
    this.player.onStateChange = (state) => {
      if (this._origStateChange) this._origStateChange(state);
      this._updateSyncPlayBtn(state);
    };

    this.overlay.classList.add('active');
    this._switchTab('import');
    if (prefillLrc) {
      let parsed = this._parseLrcToLines(prefillLrc);
      // Auto-repair late title header if present (fixes songs synced with title line)
      if (parsed.length >= 2 && this._isHeader(parsed[0].text) && parsed[0].time > 2.5) {
        const shifted = [];
        const titleClean = parsed[0].text.replace(/^♪\s*|\s*♪$/g, '').trim();
        shifted.push({ time: 0.0, text: `♪ ${titleClean} ♪`, isIntro: true });
        for (let i = 1; i < parsed.length; i++) {
          shifted.push({ time: parsed[i - 1].time, text: parsed[i].text });
        }
        parsed = shifted;
      }
      if (parsed.length > 0) {
        this.lines = parsed;
        document.getElementById('lrcImportTextarea').value = parsed.map(l => l.text).join('\n');
        this._renderEditList();
      }
    }
  }

  close() {
    this.overlay.classList.remove('active');
    this._stopSync();
    this.player.onTimeUpdate = this._origTimeUpdate;
    this.player.onStateChange = this._origStateChange;
  }

  _switchTab(tabId) {
    this.overlay.querySelectorAll('.lrc-tab-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tabId));
    this.overlay.querySelectorAll('.lrc-panel').forEach(p =>
      p.classList.toggle('active', p.dataset.panel === tabId));
    if (tabId === 'edit') this._renderEditList();
    if (tabId === 'export') this._renderExport();
  }

  _commitImport() {
    const raw = document.getElementById('lrcImportTextarea').value.trim();
    if (!raw) return;
    const isLrc = raw.includes('[') && /\[\d{1,2}:\d{2}/.test(raw);
    if (isLrc) {
      this.lines = this._parseLrcToLines(raw);
    } else {
      const splitLines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const treatIntroCheckbox = document.getElementById('lrcTreatAsIntro');
      const treatAsIntro = treatIntroCheckbox ? treatIntroCheckbox.checked : true;
      const firstLineIsHeader = splitLines.length > 1 && this._isHeader(splitLines[0]);

      if (firstLineIsHeader && treatAsIntro) {
        // Line 0 is the song title / artist header — set as 0:00 Intro!
        const titleClean = splitLines[0].replace(/^♪\s*|\s*♪$/g, '').trim();
        this.lines = [
          { text: `♪ ${titleClean} ♪`, time: 0.0, isIntro: true },
          ...splitLines.slice(1).map(text => ({ text, time: null }))
        ];
      } else {
        this.lines = splitLines.map(text => ({ text, time: null }));
      }
    }

    // If line 0 is an intro at 0:00, syncIndex starts on line 1 (the first sung lyric)!
    if (this.lines.length > 1 && this.lines[0].time === 0.0) {
      this.syncIndex = 1;
    } else {
      this.syncIndex = 0;
    }

    this._switchTab('sync');
    this._refreshSyncDisplay();
    this._updateSyncStatus();
  }

  _parseLrcToLines(lrc) {
    const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
    const metaTagRegex = /^\[[a-zA-Z]+:[^\]]*\]\s*$/;
    return lrc.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      if (metaTagRegex.test(trimmed)) return null; // Skip metadata headers [ti:] [ar:] etc
      const match = timeRegex.exec(trimmed);
      timeRegex.lastIndex = 0;
      if (match) {
        const m = parseInt(match[1], 10);
        const s = parseInt(match[2], 10);
        const ms = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) : 0;
        const time = m * 60 + s + ms / 1000;
        const text = trimmed.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
        return { text: text || '♪ ♪ ♪', time, isIntro: time === 0 };
      }
      return { text: trimmed, time: null };
    }).filter(Boolean);
  }

  _startSync() {
    if (this.lines.length === 0) {
      alert('Import lyrics first!');
      this._switchTab('import');
      return;
    }
    // Reset timestamps but preserve line 0 if it is an intro at 0:00
    this.lines = this.lines.map((l, idx) => {
      if (idx === 0 && (l.isIntro || l.time === 0.0)) {
        return { ...l, time: 0.0, isIntro: true };
      }
      return { ...l, time: null };
    });

    if (this.lines.length > 1 && this.lines[0].time === 0.0) {
      this.syncIndex = 1;
    } else {
      this.syncIndex = 0;
    }

    this.isSyncing = true;
    document.getElementById('lrcSyncTapBtn').disabled = false;
    document.getElementById('lrcSyncIntroBtn').disabled = false;
    document.getElementById('lrcSyncUndoBtn').disabled = false;
    document.getElementById('lrcSyncSkipBtn').disabled = false;
    document.getElementById('lrcSyncStartBtn').textContent = 'Restart';
    window.addEventListener('keydown', this._boundKeyHandler);
    this.player.seek(0);
    this.player.play();
    this._refreshSyncDisplay();
    this._updateSyncStatus();
  }

  _stopSync() {
    this.isSyncing = false;
    window.removeEventListener('keydown', this._boundKeyHandler);
  }

  _onSyncKey(e) {
    if (!this.isSyncing) return;
    const activeEl = document.activeElement;
    if (activeEl && ['INPUT', 'TEXTAREA'].includes(activeEl.tagName)) return;
    if (e.code === 'Enter') {
      e.preventDefault();
      this._tapTimestamp();
    } else if (e.code === 'KeyZ') {
      e.preventDefault();
      this._undoTap();
    } else if (e.code === 'KeyS') {
      e.preventDefault();
      this._skipLine();
    } else if (e.code === 'KeyI') {
      e.preventDefault();
      this._markAsIntro();
    }
  }

  _tapTimestamp() {
    if (!this.isSyncing || this.syncIndex >= this.lines.length) return;
    this.lines[this.syncIndex].time = this.player.currentTime;
    this.syncIndex++;
    this._refreshSyncDisplay();
    this._updateSyncStatus();
    if (this.syncIndex >= this.lines.length) this._syncComplete();
  }

  _markAsIntro() {
    if (!this.isSyncing || this.syncIndex >= this.lines.length) return;
    const cur = this.lines[this.syncIndex];
    cur.time = 0.0;
    cur.isIntro = true;
    if (!cur.text.startsWith('♪')) {
      cur.text = `♪ ${cur.text} ♪`;
    }
    this.syncIndex++;
    this._refreshSyncDisplay();
    this._updateSyncStatus();
    if (this.syncIndex >= this.lines.length) this._syncComplete();
  }

  _undoTap() {
    if (this.syncIndex <= 0) return;
    // Don't undo below line 1 if line 0 is a preset 0:00 intro
    const minIndex = (this.lines.length > 0 && this.lines[0].time === 0.0 && this.lines[0].isIntro) ? 1 : 0;
    if (this.syncIndex <= minIndex) return;
    this.syncIndex--;
    this.lines[this.syncIndex].time = null;
    this._refreshSyncDisplay();
    this._updateSyncStatus();
  }

  _skipLine() {
    if (!this.isSyncing || this.syncIndex >= this.lines.length) return;
    this.lines[this.syncIndex].time = null;
    this.syncIndex++;
    this._refreshSyncDisplay();
    this._updateSyncStatus();
    if (this.syncIndex >= this.lines.length) this._syncComplete();
  }

  _shiftTimestampsUp() {
    if (!this.lines || this.lines.length < 2) return;
    // Shift timestamps: line 1 gets line 0's time, line 2 gets line 1's time, etc.
    // Line 0 becomes the 0:00 Intro
    const newTimes = [];
    newTimes[0] = 0.0;
    for (let i = 1; i < this.lines.length; i++) {
      newTimes[i] = this.lines[i - 1].time;
    }
    for (let i = 0; i < this.lines.length; i++) {
      this.lines[i].time = newTimes[i];
    }
    if (!this.lines[0].text.startsWith('♪') && this._isHeader(this.lines[0].text)) {
      this.lines[0].text = `♪ ${this.lines[0].text} ♪`;
      this.lines[0].isIntro = true;
    }
    this._renderEditList();
    alert('✅ Fixed! All timestamps shifted up by 1 line, and line 1 set as 0:00 Intro. Click "Save & Apply" to apply to playback!');
  }

  _shiftTimestampsDown() {
    if (!this.lines || this.lines.length < 2) return;
    const newTimes = [];
    newTimes[0] = null;
    for (let i = 1; i < this.lines.length; i++) {
      newTimes[i] = this.lines[i - 1].time;
    }
    for (let i = 0; i < this.lines.length; i++) {
      this.lines[i].time = newTimes[i];
    }
    this._renderEditList();
  }

  _syncComplete() {
    this._stopSync();
    document.getElementById('lrcSyncFarPrevLine').textContent = '';
    document.getElementById('lrcSyncPrevLine').textContent = '';
    document.getElementById('lrcSyncCurrLine').textContent = '✅ All lines stamped!';
    document.getElementById('lrcSyncNextLine1').textContent = 'Click "Save & Apply" below to listen from the start!';
    document.getElementById('lrcSyncNextLine2').textContent = '';
    document.getElementById('lrcSyncNextLine3').textContent = '';
    document.getElementById('lrcSyncTapBtn').disabled = true;
    document.getElementById('lrcSyncIntroBtn').disabled = true;
    document.getElementById('lrcSyncSkipBtn').disabled = true;
  }

  _refreshSyncDisplay() {
    const i = this.syncIndex;
    const get = (offset) => this.lines[i + offset];

    const farPrev = get(-2);
    const prev    = get(-1);
    const curr    = get(0);
    const next1   = get(1);
    const next2   = get(2);
    const next3   = get(3);

    document.getElementById('lrcSyncFarPrevLine').textContent = farPrev ? farPrev.text : '';
    document.getElementById('lrcSyncPrevLine').textContent    = prev    ? prev.text    : '';
    document.getElementById('lrcSyncCurrLine').textContent    = curr    ? curr.text    : '-- end --';
    document.getElementById('lrcSyncNextLine1').textContent   = next1   ? next1.text   : '';
    document.getElementById('lrcSyncNextLine2').textContent   = next2   ? next2.text   : '';
    document.getElementById('lrcSyncNextLine3').textContent   = next3   ? next3.text   : '';

    // Update real-time helper instruction banner
    const instruction = document.getElementById('lrcSyncInstructionText');
    if (instruction) {
      if (!this.isSyncing) {
        if (this.syncIndex >= this.lines.length && this.lines.length > 0) {
          instruction.innerHTML = '🎉 <strong>All lines stamped!</strong> Click "Save & Apply" below to play from the beginning.';
        } else {
          instruction.innerHTML = 'Press <strong>"Start Sync"</strong> to begin playback. Then tap <kbd>Enter</kbd> as each line begins.';
        }
      } else {
        if (curr) {
          instruction.innerHTML = `🎤 <strong>Tap Enter</strong> the moment singer begins: <span style="color:#fbbf24; font-weight:600;">"${this._escapeHtml(curr.text)}"</span> (Line ${i + 1} of ${this.lines.length})`;
        } else {
          instruction.innerHTML = '🎉 <strong>All lines stamped!</strong> Click "Save & Apply" below.';
        }
      }
    }

    const pct = this.lines.length > 0 ? (i / this.lines.length) * 100 : 0;
    document.getElementById('lrcSyncProgressFill').style.width = pct + '%';
  }

  _updateSyncStatus() {
    const stamped = this.lines.filter(l => l.time !== null).length;
    document.getElementById('lrcSyncStatus').textContent = stamped + ' / ' + this.lines.length + ' lines stamped';
  }

  _updateSyncTimeline(t, d) {
    const fmt = (s) => {
      if (isNaN(s) || s < 0) s = 0;
      const m = Math.floor(s / 60), sec = Math.floor(s % 60);
      return m + ':' + (sec < 10 ? '0' : '') + sec;
    };
    const ctEl = document.getElementById('lrcSyncCurrentTime');
    const durEl = document.getElementById('lrcSyncDuration');
    const fillEl = document.getElementById('lrcSyncFill');
    if (ctEl) ctEl.textContent = fmt(t);
    if (durEl) durEl.textContent = fmt(d);
    if (fillEl && d > 0) fillEl.style.width = Math.min(100, (t / d) * 100) + '%';
  }

  _updateSyncPlayBtn(state) {
    const isPlaying = state === 'playing';
    const pi = document.getElementById('lrcSyncPlayIcon');
    const pau = document.getElementById('lrcSyncPauseIcon');
    if (pi) pi.style.display = isPlaying ? 'none' : 'block';
    if (pau) pau.style.display = isPlaying ? 'block' : 'none';
  }

  _renderEditList() {
    const container = document.getElementById('lrcLinesList');
    if (!container) return;
    container.innerHTML = '';
    this.lines.forEach((line, i) => {
      const row = document.createElement('div');
      row.className = 'lrc-edit-row';
      const timeStr = line.time !== null ? this._secToLrcTime(line.time) : '--:--:--';
      row.innerHTML =
        '<span class="lrc-row-num">' + (i + 1) + '</span>' +
        '<div class="lrc-time-control">' +
          '<button class="lrc-nudge-btn" data-action="sub1" title="-1s">-1s</button>' +
          '<button class="lrc-nudge-btn lrc-nudge-small" data-action="sub01" title="-0.1s">-</button>' +
          '<span class="lrc-time-display" data-idx="' + i + '">' + timeStr + '</span>' +
          '<button class="lrc-nudge-btn lrc-nudge-small" data-action="add01" title="+0.1s">+</button>' +
          '<button class="lrc-nudge-btn" data-action="add1" title="+1s">+1s</button>' +
        '</div>' +
        '<input class="form-input lrc-text-input" value="' + this._escapeHtml(line.text) + '" data-idx="' + i + '">' +
        '<div class="lrc-row-actions">' +
          '<button class="lrc-nudge-btn lrc-stamp-btn" data-action="stamp" title="Stamp current time">T</button>' +
          '<button class="lrc-nudge-btn lrc-del-btn" data-action="delete" title="Delete">X</button>' +
        '</div>';

      row.querySelectorAll('.lrc-nudge-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const action = btn.dataset.action;
          if (action === 'sub1')   this._nudgeTime(i, -1.0);
          if (action === 'sub01')  this._nudgeTime(i, -0.1);
          if (action === 'add01')  this._nudgeTime(i, +0.1);
          if (action === 'add1')   this._nudgeTime(i, +1.0);
          if (action === 'stamp')  this._stampCurrentTime(i);
          if (action === 'delete') this._deleteLine(i);
        });
      });
      row.querySelector('.lrc-text-input').addEventListener('input', (e) => {
        this.lines[i].text = e.target.value;
      });
      container.appendChild(row);
    });
  }

  _nudgeTime(idx, deltaSec) {
    if (this.lines[idx].time === null) this.lines[idx].time = 0;
    this.lines[idx].time = Math.max(0, this.lines[idx].time + deltaSec);
    const d = document.querySelector('.lrc-time-display[data-idx="' + idx + '"]');
    if (d) d.textContent = this._secToLrcTime(this.lines[idx].time);
  }

  _stampCurrentTime(idx) {
    this.lines[idx].time = this.player.currentTime;
    const d = document.querySelector('.lrc-time-display[data-idx="' + idx + '"]');
    if (d) d.textContent = this._secToLrcTime(this.lines[idx].time);
  }

  _deleteLine(idx) {
    this.lines.splice(idx, 1);
    this._renderEditList();
  }

  _addEditLine() {
    this.lines.push({ text: 'New line', time: null });
    this._renderEditList();
    const c = document.getElementById('lrcLinesList');
    if (c) c.scrollTop = c.scrollHeight;
  }

  _applyOffset() {
    const ms = parseFloat(document.getElementById('lrcOffsetInput').value) || 0;
    const sec = ms / 1000;
    this.lines = this.lines.map(l => ({ ...l, time: l.time !== null ? Math.max(0, l.time + sec) : null }));
    document.getElementById('lrcOffsetInput').value = 0;
    this._renderEditList();
  }

  _renderExport() {
    const el = document.getElementById('lrcExportPreview');
    if (el) el.value = this._buildLrcString();
  }

  _buildLrcString() {
    if (!this.lines || this.lines.length === 0) return '';
    const stamped = this.lines.filter(l => l.time !== null).slice().sort((a, b) => a.time - b.time);
    if (stamped.length === 0) {
      return this.lines.map((l, i) => '[' + this._secToLrcTime(i * 4) + ']' + l.text).join('\n');
    }
    return stamped.map(l => '[' + this._secToLrcTime(l.time) + ']' + l.text).join('\n');
  }

  _copyToClipboard() {
    const lrc = this._buildLrcString();
    navigator.clipboard.writeText(lrc).then(() => {
      const btn = document.getElementById('lrcExportCopy');
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    }).catch(() => {
      const el = document.getElementById('lrcExportPreview');
      if (el) { el.select(); document.execCommand('copy'); }
    });
  }

  _downloadLrc() {
    const lrc = this._buildLrcString();
    const blob = new Blob([lrc], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lyrics.lrc';
    a.click();
    URL.revokeObjectURL(url);
  }

  _applyToSong() {
    const lrc = this._buildLrcString();
    if (this.onSave) {
      this.onSave(lrc);
    }
    this.close();
    // Auto-rewind and play from beginning
    this.player.seek(0);
    this.player.play();
  }

  _secToLrcTime(sec) {
    if (sec === null || isNaN(sec)) return '--:--:--';
    const totalMs = Math.round(sec * 1000);
    const m = Math.floor(totalMs / 60000);
    const s = Math.floor((totalMs % 60000) / 1000);
    const ms = Math.floor((totalMs % 1000) / 10);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(ms).padStart(2, '0');
  }

  _escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
