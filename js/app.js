import { LyricsParser } from './lyrics-parser.js';
import { AudioPlayer } from './player.js';
import { ThemeManager, THEMES } from './theme-manager.js';
import { LrcEditor } from './lrc-editor.js';
import { Storage } from './storage.js';
import { PaletteExtractor } from './palette.js';
import { AmbientParticles } from './particles.js';

class LyricsApp {
  constructor() {
    this.appEl = document.getElementById('app');
    this.themeManager = new ThemeManager(this.appEl);
    this.player = new AudioPlayer();

    this.tracks = [];
    this.currentTrack = null;
    this.parsedLyrics = [];
    this.activeLyricIndex = -1;
    this.isScrubbing = false;

    // Track Form / Upload State
    this.editingTrackId = null;
    this.selectedCoverDataUrl = null;
    this.selectedAudioFile = null;

    this.initDOMElements();
    this.initEvents();
    this.initThemeSystem();

    // LRC Editor — created after DOM init so callbacks can be captured on open()
    this.lrcEditor = new LrcEditor(this.player, async (lrcString) => {
      if (!this.currentTrack) return;
      this.currentTrack.lrc = lrcString;
      await Storage.saveTrack(this.currentTrack);
      this.parsedLyrics = LyricsParser.parse(lrcString);
      this.renderLyrics();
      this.player.seek(0);
      this.syncLyrics(0);
      this.player.play();
    });

    this.initLibrary();
  }

  async initLibrary() {
    this.tracks = await Storage.getAllTracks();
    const lastId = Storage.getLastTrackId();
    let initialTrack = null;

    if (this.tracks.length > 0) {
      if (lastId) {
        initialTrack = this.tracks.find(t => t.id === lastId) || this.tracks[0];
      } else {
        initialTrack = this.tracks[0];
      }
    }

    if (initialTrack) {
      await this.loadTrack(initialTrack);
    } else {
      this.renderEmptyLibraryState();
    }
  }

  initDOMElements() {
    // Header & Info Elements
    this.artistAmharic = document.getElementById('artistAmharic');
    this.artistEnglish = document.getElementById('artistEnglish');
    this.songTitleAmharic = document.getElementById('songTitleAmharic');
    this.albumTitle = document.getElementById('albumTitle');
    this.albumYear = document.getElementById('albumYear');
    this.discArtwork = document.getElementById('discArtwork');
    this.vinylDisc = document.getElementById('vinylDisc');

    // Mini Player Info
    this.playerMiniArt = document.getElementById('playerMiniArt');
    this.playerMiniTitle = document.getElementById('playerMiniTitle');
    this.playerMiniArtist = document.getElementById('playerMiniArtist');

    // Lyrics Container
    this.lyricsViewport = document.getElementById('lyricsViewport');
    this.lyricsScrollWrap = document.getElementById('lyricsScrollWrap');
    this.noLyricsFileInput = document.getElementById('noLyricsFileInput');

    // Ambient Particles Canvas (Subtle Floating Snowflakes/Dust)
    this.ambientParticlesCanvas = document.getElementById('ambientParticlesCanvas');
    if (this.ambientParticlesCanvas) {
      this.ambientParticles = new AmbientParticles(this.ambientParticlesCanvas);
    }

    // Controls
    this.btnPlayPause = document.getElementById('btnPlayPause');
    this.playIcon = document.getElementById('playIcon');
    this.pauseIcon = document.getElementById('pauseIcon');
    this.btnRewind = document.getElementById('btnRewind');
    this.btnForward = document.getElementById('btnForward');
    this.btnSpeed = document.getElementById('btnSpeed');
    this.btnMute = document.getElementById('btnMute');
    this.volumeSlider = document.getElementById('volumeSlider');
    this.scrubberTrack = document.getElementById('scrubberTrack');
    this.scrubberFill = document.getElementById('scrubberFill');
    this.currentTimeLabel = document.getElementById('currentTimeLabel');
    this.durationLabel = document.getElementById('durationLabel');
    this.btnToggleFullscreen = document.getElementById('btnToggleFullscreen');

    // Modals
    this.themeModal = document.getElementById('themeModal');
    this.btnOpenThemeModal = document.getElementById('btnOpenThemeModal');
    this.themeOptionsList = document.getElementById('themeOptionsList');

    this.trackModal = document.getElementById('trackModal');
    this.btnOpenTrackModal = document.getElementById('btnOpenTrackModal');
    this.presetTracksList = document.getElementById('presetTracksList');
    this.btnOpenLrcEditor = document.getElementById('btnOpenLrcEditor');

    // Track Modal Views & Navigation
    this.trackListView = document.getElementById('trackListView');
    this.trackFormView = document.getElementById('trackFormView');
    this.btnShowUploadForm = document.getElementById('btnShowUploadForm');
    this.btnBackToLibrary = document.getElementById('btnBackToLibrary');
    this.btnCancelTrackForm = document.getElementById('btnCancelTrackForm');
    this.trackFormModeTitle = document.getElementById('trackFormModeTitle');
    this.trackFormError = document.getElementById('trackFormError');
    this.audioRequiredBadge = document.getElementById('audioRequiredBadge');

    // Cover Artwork Elements
    this.coverPreviewBox = document.getElementById('coverPreviewBox');
    this.coverPreviewImg = document.getElementById('coverPreviewImg');
    this.coverFileInput = document.getElementById('coverFileInput');
    this.btnUploadCoverFile = document.getElementById('btnUploadCoverFile');
    this.btnRemoveCover = document.getElementById('btnRemoveCover');

    // Custom Upload Form
    this.audioDropzone = document.getElementById('audioDropzone');
    this.audioFileInput = document.getElementById('audioFileInput');
    this.audioDropzoneLabel = document.getElementById('audioDropzoneLabel');
    this.btnUploadLrc = document.getElementById('btnUploadLrc');
    this.lrcFileInput = document.getElementById('lrcFileInput');
    this.inputCustomArtist = document.getElementById('inputCustomArtist');
    this.inputCustomTitle = document.getElementById('inputCustomTitle');
    this.inputCustomAlbum = document.getElementById('inputCustomAlbum');
    this.inputCustomYear = document.getElementById('inputCustomYear');
    this.inputCustomLrc = document.getElementById('inputCustomLrc');
    this.btnApplyCustomTrack = document.getElementById('btnApplyCustomTrack');
  }

  initEvents() {
    // Play / Pause
    this.btnPlayPause.addEventListener('click', () => {
      if (!this.currentTrack) {
        this.trackModal.classList.add('active');
        return;
      }
      this.player.togglePlay();
    });

    // Rewind / Forward 5s
    this.btnRewind.addEventListener('click', () => {
      if (this.currentTrack) this.player.seek(this.player.currentTime - 5);
    });
    this.btnForward.addEventListener('click', () => {
      if (this.currentTrack) this.player.seek(this.player.currentTime + 5);
    });

    // Playback Speed Toggle (1.0x -> 1.25x -> 1.5x -> 0.75x -> 1.0x)
    const speeds = [1.0, 1.25, 1.5, 0.75];
    let speedIdx = 0;
    this.btnSpeed.addEventListener('click', () => {
      speedIdx = (speedIdx + 1) % speeds.length;
      const spd = speeds[speedIdx];
      this.player.setPlaybackRate(spd);
      this.btnSpeed.textContent = `${spd}x`;
    });

    // Audio Player State Listeners
    this.player.onStateChange = (state) => {
      if (state === 'playing') {
        this.playIcon.style.display = 'none';
        this.pauseIcon.style.display = 'block';
        this.vinylDisc.classList.remove('paused');
        this.vinylDisc.classList.add('spinning');
      } else {
        this.playIcon.style.display = 'block';
        this.pauseIcon.style.display = 'none';
        this.vinylDisc.classList.add('paused');
      }
    };

    this.player.onTimeUpdate = (currentTime, duration) => {
      if (!this.isScrubbing) {
        this.updateTimeline(currentTime, duration);
      }
      this.syncLyrics(currentTime);
    };

    this.player.onEnded = () => {
      this.playIcon.style.display = 'block';
      this.pauseIcon.style.display = 'none';
      this.vinylDisc.classList.remove('spinning');
      this.syncLyrics(0);
    };

    // Volume & Mute
    let lastVolume = 0.8;
    this.volumeSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.player.setVolume(val);
      if (val > 0) lastVolume = val;
    });

    this.btnMute.addEventListener('click', () => {
      if (this.player.volume > 0) {
        this.player.setVolume(0);
        this.volumeSlider.value = 0;
      } else {
        this.player.setVolume(lastVolume);
        this.volumeSlider.value = lastVolume;
      }
    });

    // Timeline Scrubber Seeking (Mouse Click & Touch Drag Support)
    const seekAtClientX = (clientX) => {
      if (!this.currentTrack || !this.player.duration) return;
      const rect = this.scrubberTrack.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      this.player.seek(pos * this.player.duration);
    };

    this.scrubberTrack.addEventListener('click', (e) => {
      seekAtClientX(e.clientX);
    });

    this.scrubberTrack.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches[0]) {
        this.isScrubbing = true;
        seekAtClientX(e.touches[0].clientX);
      }
    }, { passive: true });

    this.scrubberTrack.addEventListener('touchmove', (e) => {
      if (this.isScrubbing && e.touches && e.touches[0]) {
        seekAtClientX(e.touches[0].clientX);
      }
    }, { passive: true });

    this.scrubberTrack.addEventListener('touchend', () => {
      this.isScrubbing = false;
    }, { passive: true });

    // Fullscreen Toggle
    this.btnToggleFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (['input', 'textarea'].includes(document.activeElement.tagName.toLowerCase())) return;
      if (this.lrcEditor && this.lrcEditor.overlay.classList.contains('active')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (this.currentTrack) this.player.togglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        if (this.currentTrack) this.player.seek(this.player.currentTime - 5);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        if (this.currentTrack) this.player.seek(this.player.currentTime + 5);
      }
    });

    // Open Modals
    this.btnOpenThemeModal.addEventListener('click', () => {
      this.themeModal.classList.add('active');
    });
    this.btnOpenTrackModal.addEventListener('click', () => {
      this.showTrackList();
      this.trackModal.classList.add('active');
    });
    this.btnOpenLrcEditor.addEventListener('click', () => {
      if (!this.currentTrack) {
        this.showTrackList();
        this.trackModal.classList.add('active');
        return;
      }
      this.lrcEditor.open(this.currentTrack.lrc || '');
    });

    // Close Modals
    document.querySelectorAll('.modal-close-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const modalId = e.target.getAttribute('data-close');
        document.getElementById(modalId).classList.remove('active');
      });
    });

    // Backdrop click close
    [this.themeModal, this.trackModal].forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('active');
      });
    });

    // Switch between Track List and Form Views
    this.btnShowUploadForm.addEventListener('click', () => {
      this.showTrackForm();
    });
    this.btnBackToLibrary.addEventListener('click', () => {
      this.showTrackList();
    });
    this.btnCancelTrackForm.addEventListener('click', () => {
      this.showTrackList();
    });

    // Cover Artwork Picker
    this.coverPreviewBox.addEventListener('click', () => this.coverFileInput.click());
    this.btnUploadCoverFile.addEventListener('click', () => this.coverFileInput.click());
    this.coverFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          this.selectedCoverDataUrl = evt.target.result;
          this.coverPreviewImg.src = evt.target.result;
        };
        reader.readAsDataURL(file);
      }
    });

    this.btnRemoveCover.addEventListener('click', () => {
      this.selectedCoverDataUrl = '';
      this.coverPreviewImg.src = 'assets/weleta_cover.jpg';
      this.coverFileInput.value = '';
    });

    // Custom Audio File Dropzone
    this.audioDropzone.addEventListener('click', () => this.audioFileInput.click());
    this.audioFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        this.audioDropzoneLabel.textContent = `🎵 Selected: ${file.name}`;
        this.selectedAudioFile = file;

        // Auto-fill title if empty
        if (!this.inputCustomTitle.value) {
          const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
          this.inputCustomTitle.value = nameWithoutExt;
        }
      }
    });

    // HTML5 Drag & Drop for Audio and Cover
    ['dragenter', 'dragover'].forEach(name => {
      this.audioDropzone.addEventListener(name, (e) => {
        e.preventDefault();
        this.audioDropzone.style.borderColor = 'rgba(255,255,255,0.7)';
        this.audioDropzone.style.background = 'rgba(255,255,255,0.08)';
      });
      this.coverPreviewBox.addEventListener(name, (e) => {
        e.preventDefault();
        this.coverPreviewBox.style.borderColor = '#ffffff';
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      this.audioDropzone.addEventListener(name, (e) => {
        e.preventDefault();
        this.audioDropzone.style.borderColor = '';
        this.audioDropzone.style.background = '';
      });
      this.coverPreviewBox.addEventListener(name, (e) => {
        e.preventDefault();
        this.coverPreviewBox.style.borderColor = '';
      });
    });

    this.audioDropzone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        const file = e.dataTransfer.files[0];
        if (file.type.startsWith('audio/') || file.name.match(/\.(mp3|wav|ogg|m4a|aac|flac)$/i)) {
          this.selectedAudioFile = file;
          this.audioDropzoneLabel.textContent = `🎵 Selected: ${file.name}`;
          if (!this.inputCustomTitle.value) {
            const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
            this.inputCustomTitle.value = nameWithoutExt;
          }
        }
      }
    });

    this.coverPreviewBox.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        const file = e.dataTransfer.files[0];
        if (file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = (evt) => {
            this.selectedCoverDataUrl = evt.target.result;
            this.coverPreviewImg.src = evt.target.result;
          };
          reader.readAsDataURL(file);
        }
      }
    });

    // Custom LRC File inside Modal
    this.btnUploadLrc.addEventListener('click', () => this.lrcFileInput.click());
    this.lrcFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          this.inputCustomLrc.value = evt.target.result;
        };
        reader.readAsText(file);
      }
    });

    // Direct LRC Upload from Empty State
    if (this.noLyricsFileInput) {
      this.noLyricsFileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file && this.currentTrack) {
          const reader = new FileReader();
          reader.onload = async (evt) => {
            const lrcContent = evt.target.result;
            this.currentTrack.lrc = lrcContent;
            await Storage.saveTrack(this.currentTrack);
            this.parsedLyrics = LyricsParser.parse(lrcContent);
            this.renderLyrics();
            this.syncLyrics(this.player.currentTime);
          };
          reader.readAsText(file);
        }
      });
    }

    // Apply & Save Track
    this.btnApplyCustomTrack.addEventListener('click', () => {
      this.applyCustomTrack();
    });
  }

  initThemeSystem() {
    this.themeManager.init();

    this.themeOptionsList.innerHTML = '';
    THEMES.forEach(t => {
      const card = document.createElement('div');
      card.className = `theme-card-option ${this.themeManager.currentTheme === t.id ? 'active' : ''}`;
      card.innerHTML = `
        <div class="theme-card-info">
          <h3>${t.name}</h3>
          <p>${t.description}</p>
        </div>
        <span class="theme-badge">${t.badge}</span>
      `;
      card.addEventListener('click', () => {
        this.themeManager.applyTheme(t.id);
        document.querySelectorAll('.theme-card-option').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        this.themeModal.classList.remove('active');
        requestAnimationFrame(() => {
          this.syncLyrics(this.player.currentTime);
        });
      });
      this.themeOptionsList.appendChild(card);
    });
  }

  showTrackList() {
    this.editingTrackId = null;
    this.clearFormErrors();
    if (this.trackListView) this.trackListView.style.display = 'block';
    if (this.trackFormView) this.trackFormView.style.display = 'none';
    if (this.btnShowUploadForm) this.btnShowUploadForm.style.display = 'inline-flex';
    this.populateTracksModal();
  }

  showTrackForm(trackToEdit = null) {
    this.clearFormErrors();
    if (this.trackListView) this.trackListView.style.display = 'none';
    if (this.trackFormView) this.trackFormView.style.display = 'flex';
    if (this.btnShowUploadForm) this.btnShowUploadForm.style.display = 'none';

    if (trackToEdit) {
      this.editingTrackId = trackToEdit.id;
      if (this.trackFormModeTitle) this.trackFormModeTitle.textContent = 'Edit Song Metadata & Artwork';
      if (this.btnApplyCustomTrack) this.btnApplyCustomTrack.textContent = 'Save Changes';
      if (this.audioRequiredBadge) {
        this.audioRequiredBadge.textContent = '(Optional - keep existing audio)';
        this.audioRequiredBadge.className = 'optional-badge';
      }

      this.inputCustomArtist.value = trackToEdit.artist || '';
      this.inputCustomTitle.value = trackToEdit.title || '';
      this.inputCustomAlbum.value = trackToEdit.album || '';
      this.inputCustomYear.value = trackToEdit.year || '';
      this.inputCustomLrc.value = trackToEdit.lrc || '';

      this.selectedAudioFile = null;
      if (this.audioFileInput) this.audioFileInput.value = '';
      if (this.audioDropzoneLabel) this.audioDropzoneLabel.textContent = '🎵 Existing Audio Attached (Click to replace file)';

      this.selectedCoverDataUrl = trackToEdit.cover || null;
      if (this.coverPreviewImg) this.coverPreviewImg.src = trackToEdit.cover || 'assets/weleta_cover.jpg';
      if (this.coverFileInput) this.coverFileInput.value = '';
    } else {
      this.editingTrackId = null;
      if (this.trackFormModeTitle) this.trackFormModeTitle.textContent = 'Upload New Song';
      if (this.btnApplyCustomTrack) this.btnApplyCustomTrack.textContent = 'Save & Play Song';
      if (this.audioRequiredBadge) {
        this.audioRequiredBadge.textContent = '* Required';
        this.audioRequiredBadge.className = 'required-badge';
      }

      this.inputCustomArtist.value = '';
      this.inputCustomTitle.value = '';
      this.inputCustomAlbum.value = '';
      this.inputCustomYear.value = '';
      this.inputCustomLrc.value = '';

      this.selectedAudioFile = null;
      if (this.audioFileInput) this.audioFileInput.value = '';
      if (this.audioDropzoneLabel) this.audioDropzoneLabel.textContent = 'Click or Drag & Drop Audio File (MP3, WAV, AAC, M4A)';

      this.selectedCoverDataUrl = null;
      if (this.coverPreviewImg) this.coverPreviewImg.src = 'assets/weleta_cover.jpg';
      if (this.coverFileInput) this.coverFileInput.value = '';
    }
  }

  showFormError(msg) {
    if (this.trackFormError) {
      this.trackFormError.textContent = msg;
      this.trackFormError.style.display = 'block';
    }
  }

  clearFormErrors() {
    if (this.trackFormError) {
      this.trackFormError.textContent = '';
      this.trackFormError.style.display = 'none';
    }
    if (this.inputCustomArtist) this.inputCustomArtist.style.borderColor = '';
    if (this.inputCustomTitle) this.inputCustomTitle.style.borderColor = '';
  }

  populateTracksModal() {
    this.presetTracksList.innerHTML = '';

    if (!this.tracks || this.tracks.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'empty-library-state';
      emptyMsg.innerHTML = `
        <div style="font-size:2.2rem; margin-bottom:0.25rem;">📂</div>
        <div style="font-weight:600; font-size:1.05rem; color:#fff;">Your Library is Empty</div>
        <div style="font-size:0.85rem; color:var(--color-text-dim); max-width:340px; margin-top:0.25rem; line-height:1.4;">
          Upload your favorite audio songs, custom album artwork, and synchronized lyrics to begin.
        </div>
        <button id="btnModalAddFirstTrack" class="btn-pill btn-primary-action" style="margin-top:0.75rem; padding:0.5rem 1.1rem; font-size:0.85rem;">
          + Upload Your First Song
        </button>
      `;
      this.presetTracksList.appendChild(emptyMsg);

      const addBtn = emptyMsg.querySelector('#btnModalAddFirstTrack');
      if (addBtn) {
        addBtn.addEventListener('click', () => {
          this.showTrackForm();
        });
      }
      return;
    }

    this.tracks.forEach(song => {
      const isCurrent = this.currentTrack && this.currentTrack.id === song.id;
      const item = document.createElement('div');
      item.className = `theme-card-option ${isCurrent ? 'active' : ''}`;
      item.style.padding = '0.75rem 1rem';
      item.innerHTML = `
        <div style="display:flex; align-items:center; gap:0.75rem; flex:1; min-width:0;">
          <img src="${song.cover || 'assets/weleta_cover.jpg'}" class="track-thumb-img" alt="${song.title}" onerror="this.src='assets/weleta_cover.jpg'">
          <div style="overflow:hidden;">
            <div style="font-weight:600; font-size:0.92rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${song.title} - ${song.artist}</div>
            <div style="font-size:0.75rem; color:var(--color-text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${song.album || 'Single'} (${song.year || '2024'}) • ${song.lrc ? 'Synced Lyrics' : 'No Lyrics'}
            </div>
          </div>
        </div>
        <div style="display:flex; gap:0.4rem; flex-shrink:0; align-items:center;">
          <button class="btn-pill btn-play-custom" style="font-size:0.75rem; padding:0.35rem 0.75rem;">${isCurrent && this.player.isPlaying ? 'Playing' : 'Play'}</button>
          <button class="btn-pill btn-edit-custom" style="font-size:0.75rem; padding:0.35rem 0.65rem;" title="Edit Metadata & Artwork">✏️ Edit</button>
          <button class="btn-pill btn-delete-custom" style="font-size:0.75rem; padding:0.35rem 0.55rem; color:#ff6b6b;" title="Delete Song">✕</button>
        </div>
      `;

      item.querySelector('.btn-play-custom').addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.loadTrack(song);
        this.trackModal.classList.remove('active');
        this.player.play();
      });

      item.querySelector('.btn-edit-custom').addEventListener('click', (e) => {
        e.stopPropagation();
        this.showTrackForm(song);
      });

      item.querySelector('.btn-delete-custom').addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.deleteTrack(song.id);
      });

      item.addEventListener('click', async () => {
        await this.loadTrack(song);
        this.trackModal.classList.remove('active');
        this.player.play();
      });

      this.presetTracksList.appendChild(item);
    });
  }

  async loadTrack(track) {
    this.currentTrack = track;
    Storage.setLastTrackId(track.id);

    // Update Header Display
    this.artistAmharic.textContent = track.artist || 'Unknown Artist';
    this.artistEnglish.textContent = track.artistEn || track.artist || 'Unknown Artist';
    this.songTitleAmharic.textContent = track.title || 'Untitled Track';
    this.albumTitle.textContent = track.album || 'My Album';
    this.albumYear.textContent = track.year || '2024';

    // Update Images & Mini Player
    const coverUrl = track.cover || 'assets/weleta_cover.jpg';
    const discUrl = track.discCenter || coverUrl;
    this.discArtwork.src = discUrl;
    this.playerMiniArt.src = coverUrl;
    this.playerMiniTitle.textContent = track.title;
    this.playerMiniArtist.textContent = track.artist;

    // Load Audio in Engine
    this.player.loadTrack(track);

    // Dynamically extract colors from album artwork for ambient theme
    PaletteExtractor.extractFromImage(coverUrl).then(palette => {
      PaletteExtractor.applyToElement(this.appEl, palette);
    });

    // Parse Lyrics
    this.parsedLyrics = LyricsParser.parse(track.lrc || '');
    this.renderLyrics();
    this.syncLyrics(0);
    this.updateTimeline(0, track.duration || 180);
  }

  renderEmptyLibraryState() {
    this.currentTrack = null;
    this.parsedLyrics = [];

    // Reset palette to elegant default
    PaletteExtractor.applyToElement(this.appEl, PaletteExtractor.getDefaultPalette());

    // Header Display
    this.artistAmharic.textContent = 'የሙዚቃ ማጫወቻ';
    this.artistEnglish.textContent = 'ETHIO LYRICS PLAYER';
    this.songTitleAmharic.textContent = 'ሙዚቃ ይምረጡ';
    this.albumTitle.textContent = 'Library';
    this.albumYear.textContent = new Date().getFullYear().toString();

    // Mini Player Info
    this.playerMiniTitle.textContent = 'No Track Loaded';
    this.playerMiniArtist.textContent = 'Upload or select a track to begin';

    // Render Lyrics Stage Call to Action
    this.lyricsScrollWrap.innerHTML = `
      <div class="lyrics-no-content">
        <div class="no-lyrics-icon">🎵</div>
        <div class="no-lyrics-title">No Tracks in Library</div>
        <div class="no-lyrics-subtitle">Upload an audio song (MP3, WAV, M4A) with synchronized lyrics to start playing with stunning visual themes.</div>
        <div class="no-lyrics-actions">
          <button id="btnEmptyUploadTrack" class="btn-pill btn-primary-action">
            <span>📂</span> <span>Upload Song &amp; Lyrics</span>
          </button>
        </div>
      </div>
    `;

    document.getElementById('btnEmptyUploadTrack').addEventListener('click', () => {
      this.showTrackForm();
      this.trackModal.classList.add('active');
    });

    this.lyricsScrollWrap.style.transform = 'none';
  }

  renderLyrics() {
    this.lyricsScrollWrap.innerHTML = '';
    this.activeLyricIndex = -1;

    // If no lyrics are attached to this track, show the refined call-to-action state
    if (!this.parsedLyrics || this.parsedLyrics.length === 0) {
      this.lyricsScrollWrap.innerHTML = `
        <div class="lyrics-no-content">
          <div class="no-lyrics-icon">📜</div>
          <div class="no-lyrics-title">Lyrics Unavailable</div>
          <div class="no-lyrics-subtitle">No synchronized lyrics found for "${this.currentTrack ? this.currentTrack.title : 'this song'}". You can upload an .LRC file or use the editor to create synchronized lyrics!</div>
          <div class="no-lyrics-actions">
            <button id="btnNoLyricsUploadLrc" class="btn-pill btn-primary-action">
              <span>📂</span> <span>Upload .LRC File</span>
            </button>
            <button id="btnNoLyricsOpenEditor" class="btn-pill btn-secondary-action">
              <span>✍️</span> <span>Add / Sync Lyrics</span>
            </button>
          </div>
        </div>
      `;

      document.getElementById('btnNoLyricsUploadLrc').addEventListener('click', () => {
        if (this.noLyricsFileInput) this.noLyricsFileInput.click();
      });

      document.getElementById('btnNoLyricsOpenEditor').addEventListener('click', () => {
        this.lrcEditor.open(this.currentTrack ? (this.currentTrack.lrc || '') : '');
      });

      this.lyricsScrollWrap.style.transform = 'none';
      return;
    }

    this.parsedLyrics.forEach((line, index) => {
      const lineEl = document.createElement('div');
      lineEl.className = 'lyric-line distant';
      lineEl.dataset.time = line.time;
      lineEl.dataset.index = index;
      lineEl.textContent = line.text;

      // Click to seek directly to timestamp
      lineEl.addEventListener('click', () => {
        this.player.seek(line.time);
        if (!this.player.isPlaying) this.player.play();
      });

      this.lyricsScrollWrap.appendChild(lineEl);
    });
  }

  syncLyrics(currentTime) {
    if (!this.parsedLyrics || this.parsedLyrics.length === 0) return;

    const newIndex = LyricsParser.getActiveIndex(this.parsedLyrics, currentTime);
    if (newIndex === this.activeLyricIndex && this.activeLyricIndex !== -1) return;

    const oldIndex = this.activeLyricIndex;
    this.activeLyricIndex = newIndex;
    const lines = this.lyricsScrollWrap.children;
    if (!lines || lines.length === 0) return;

    // High Performance: Only update classes for lines whose state actually changed!
    // Instead of dirtying all 100+ DOM nodes, we only touch near and newly distant lines.
    const indicesToTouch = new Set();
    if (oldIndex >= 0) {
      indicesToTouch.add(oldIndex - 1);
      indicesToTouch.add(oldIndex);
      indicesToTouch.add(oldIndex + 1);
    }
    if (newIndex >= 0) {
      indicesToTouch.add(newIndex - 1);
      indicesToTouch.add(newIndex);
      indicesToTouch.add(newIndex + 1);
    } else {
      // Intro state before lyrics start
      indicesToTouch.add(0);
      indicesToTouch.add(1);
    }

    indicesToTouch.forEach(idx => {
      if (idx >= 0 && idx < lines.length) {
        const el = lines[idx];
        let targetClass = 'lyric-line distant';
        if (newIndex === -1) {
          if (idx === 0) targetClass = 'lyric-line next near';
        } else {
          const diff = idx - newIndex;
          if (diff === 0) targetClass = 'lyric-line active';
          else if (diff === -1) targetClass = 'lyric-line prev near';
          else if (diff === 1) targetClass = 'lyric-line next near';
        }
        if (el.className !== targetClass) {
          el.className = targetClass;
        }
      }
    });

    // Schedule scroll calculation via requestAnimationFrame to avoid synchronous layout thrashing
    if (this._scrollRafId) cancelAnimationFrame(this._scrollRafId);
    this._scrollRafId = requestAnimationFrame(() => {
      if (newIndex >= 0 && lines[newIndex]) {
        const activeEl = lines[newIndex];
        const wrapHeight = this.lyricsViewport.offsetHeight || 420;
        const elTop = activeEl.offsetTop;
        const elHeight = activeEl.offsetHeight || 48;
        const targetScroll = (wrapHeight / 2) - elTop - (elHeight / 2);
        this.lyricsScrollWrap.style.transform = `translate3d(0, ${targetScroll}px, 0)`;
      } else if (newIndex === -1 && lines[0]) {
        const firstEl = lines[0];
        const wrapHeight = this.lyricsViewport.offsetHeight || 420;
        const elTop = firstEl.offsetTop;
        const elHeight = firstEl.offsetHeight || 48;
        const targetScroll = (wrapHeight / 2) - elTop - (elHeight / 2) + 65;
        this.lyricsScrollWrap.style.transform = `translate3d(0, ${targetScroll}px, 0)`;
      }
    });
  }

  updateTimeline(currentTime, duration) {
    const formattedCurrent = LyricsParser.formatTime(currentTime);
    if (this.currentTimeLabel.textContent !== formattedCurrent) {
      this.currentTimeLabel.textContent = formattedCurrent;
    }

    const formattedDuration = LyricsParser.formatTime(duration);
    if (this.durationLabel.textContent !== formattedDuration) {
      this.durationLabel.textContent = formattedDuration;
    }

    if (duration > 0) {
      const percent = Math.min(100, Math.max(0, (currentTime / duration) * 100));
      this.scrubberFill.style.width = `${percent}%`;
    }
  }

  async applyCustomTrack() {
    this.clearFormErrors();

    const artist = this.inputCustomArtist.value.trim();
    const title = this.inputCustomTitle.value.trim();
    const album = this.inputCustomAlbum.value.trim() || 'Single';
    const year = this.inputCustomYear.value.trim() || new Date().getFullYear().toString();
    const lrc = this.inputCustomLrc.value.trim() || '';

    // Validate only Artist Name and Song Title as mandatory
    let hasError = false;
    if (!artist) {
      this.inputCustomArtist.style.borderColor = '#ef4444';
      hasError = true;
    }
    if (!title) {
      this.inputCustomTitle.style.borderColor = '#ef4444';
      hasError = true;
    }

    if (hasError) {
      this.showFormError('Artist Name and Song Title are required.');
      if (!artist) this.inputCustomArtist.focus();
      else if (!title) this.inputCustomTitle.focus();
      return;
    }

    // Determine artwork URLs
    let coverArt = this.selectedCoverDataUrl;
    if (!coverArt && !this.editingTrackId) {
      coverArt = 'assets/weleta_cover.jpg';
    }
    let discArt = this.selectedCoverDataUrl;
    if (!discArt && !this.editingTrackId) {
      discArt = 'assets/abinet_portrait.jpg';
    }

    // Editing Existing Track Mode
    if (this.editingTrackId) {
      const existingTrack = this.tracks.find(t => t.id === this.editingTrackId);
      if (existingTrack) {
        existingTrack.title = title;
        existingTrack.titleEn = title;
        existingTrack.artist = artist;
        existingTrack.artistEn = artist;
        existingTrack.album = album;
        existingTrack.year = year;
        existingTrack.lrc = lrc;

        if (this.selectedCoverDataUrl !== null) {
          existingTrack.cover = this.selectedCoverDataUrl || 'assets/weleta_cover.jpg';
          existingTrack.discCenter = this.selectedCoverDataUrl || 'assets/abinet_portrait.jpg';
        }

        if (this.selectedAudioFile) {
          existingTrack.audioBlob = this.selectedAudioFile;
        }

        await Storage.saveTrack(existingTrack);
        this.tracks = await Storage.getAllTracks();

        // If editing the currently loaded/playing track, update interface immediately!
        if (this.currentTrack && this.currentTrack.id === existingTrack.id) {
          this.currentTrack = existingTrack;
          this.artistAmharic.textContent = existingTrack.artist;
          this.artistEnglish.textContent = existingTrack.artistEn || existingTrack.artist;
          this.songTitleAmharic.textContent = existingTrack.title;
          this.albumTitle.textContent = existingTrack.album;
          this.albumYear.textContent = existingTrack.year;
          this.discArtwork.src = existingTrack.discCenter || existingTrack.cover || 'assets/weleta_cover.jpg';
          this.playerMiniArt.src = existingTrack.cover || 'assets/weleta_cover.jpg';
          this.playerMiniTitle.textContent = existingTrack.title;
          // Update dynamic ambient palette if artwork was modified
          if (this.selectedCoverDataUrl !== null) {
            PaletteExtractor.extractFromImage(existingTrack.cover || 'assets/weleta_cover.jpg').then(palette => {
              PaletteExtractor.applyToElement(this.appEl, palette);
            });
          }

          // If audio was replaced, reload audio into player
          if (this.selectedAudioFile) {
            this.player.loadTrack(existingTrack);
          }

          // Re-parse and update lyrics
          this.parsedLyrics = LyricsParser.parse(existingTrack.lrc || '');
          this.renderLyrics();
          this.syncLyrics(this.player.currentTime);
        }

        this.showTrackList();
        return;
      }
    }

    // New Track Creation Mode: Requires an audio file
    if (!this.selectedAudioFile) {
      this.showFormError('Please select or drop an audio file for your track.');
      return;
    }

    const newTrack = {
      id: `track_${Date.now()}`,
      title: title,
      titleEn: title,
      artist: artist,
      artistEn: artist,
      album: album,
      year: year,
      cover: coverArt || 'assets/weleta_cover.jpg',
      discCenter: discArt || 'assets/abinet_portrait.jpg',
      duration: 180,
      lrc: lrc,
      audioBlob: this.selectedAudioFile
    };

    // Save track to IndexedDB
    await Storage.saveTrack(newTrack);
    this.tracks = await Storage.getAllTracks();

    // Reset inputs
    this.inputCustomArtist.value = '';
    this.inputCustomTitle.value = '';
    this.inputCustomAlbum.value = '';
    this.inputCustomYear.value = '';
    this.inputCustomLrc.value = '';
    this.selectedAudioFile = null;
    this.selectedCoverDataUrl = null;

    // Load and play
    await this.loadTrack(newTrack);
    this.trackModal.classList.remove('active');
    this.player.play();
  }

  async deleteTrack(trackId) {
    await Storage.deleteTrack(trackId);
    this.tracks = await Storage.getAllTracks();
    this.populateTracksModal();

    if (this.currentTrack && this.currentTrack.id === trackId) {
      if (this.tracks.length > 0) {
        await this.loadTrack(this.tracks[0]);
      } else {
        this.renderEmptyLibraryState();
      }
    }
  }
}

// Instantiate on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.lyricsApp = new LyricsApp();
});
