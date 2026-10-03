import { LyricsParser } from './lyrics-parser.js';
import { AudioPlayer } from './player.js';
import { ThemeManager, THEMES } from './theme-manager.js';
import { LrcEditor } from './lrc-editor.js';
import { Storage } from './storage.js';
import { PaletteExtractor } from './palette.js';
import { AmbientParticles } from './particles.js';
import { FirebaseService, ADMIN_EMAIL, R2_PUBLIC_BASE } from './firebase-service.js';

class LyricsApp {
  constructor() {
    this.appEl = document.getElementById('app');
    this.themeManager = new ThemeManager(this.appEl);
    this.player = new AudioPlayer();

    this.tracks = []; // Local IndexedDB tracks
    this.publicTracks = []; // Firestore / Cloudflare R2 Global Catalog
    this.currentTrack = null;
    this.parsedLyrics = [];
    this.activeLyricIndex = -1;
    this.isScrubbing = false;

    // View & Navigation State
    this.currentView = 'home'; // 'home' | 'stage'
    this.activeFilter = 'all'; // 'all' | 'suggested' | 'classic' | 'pop' | 'lrc' | 'offline'
    this.searchQuery = '';

    // Auth & Role State
    this.currentUser = null;
    this.isAdmin = false;
    this.currentLibraryTab = 'global'; // 'global' | 'offline'

    // Track Form / Upload State
    this.editingTrackId = null;
    this.selectedCoverDataUrl = null;
    this.selectedAudioFile = null;

    this.initDOMElements();

    // LRC Editor - instantiated early so it is immediately accessible to settings & buttons
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

    this.initThemeSystem();
    this.initAuth();
    this.initEvents();
    this.initPullToRefresh();
    this.initServiceWorker();
    this.initLibrary();
  }

  initServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
          console.warn('Service worker registration failed:', err);
        });
      });
    }
  }

  async initLibrary() {
    // 1. Clean up legacy hardcoded sample tracks from early development
    this.tracks = await Storage.getAllTracks();
    const legacyIds = ['abinet_athijibegn', 'ethio_tizita'];
    let needsClean = false;
    for (const id of legacyIds) {
      if (this.tracks.some(t => t.id === id)) {
        await Storage.deleteTrack(id);
        needsClean = true;
      }
    }
    if (needsClean) {
      this.tracks = await Storage.getAllTracks();
    }

    // 2. Fetch Global Cloud Catalog from Firestore & Cloudflare R2
    await this.loadPublicCatalog();

    // 3. Determine initial song to spotlight
    const allAvailable = [...this.publicTracks, ...this.tracks];
    const lastId = Storage.getLastTrackId();
    let initialTrack = null;

    if (allAvailable.length > 0) {
      if (lastId) {
        initialTrack = allAvailable.find(t => t.id === lastId) || allAvailable[0];
      } else {
        initialTrack = allAvailable[0];
      }
    }

    if (initialTrack) {
      await this.loadTrack(initialTrack, false); // load metadata without autoplaying
    } else {
      this.renderEmptyLibraryState();
    }

    // 4. Render Home Music Suggestion & Discovery View
    this.renderHomePage();
  }

  initDOMElements() {
    // Primary Tab Views & Navigation
    this.tabViewHome = document.getElementById('tabViewHome');
    this.tabViewLibrary = document.getElementById('tabViewLibrary');
    this.tabViewLyrics = document.getElementById('tabViewLyrics');
    this.tabViewSettings = document.getElementById('tabViewSettings');
    this.homeExploreView = this.tabViewHome;
    this.lyricsStageView = this.tabViewLyrics;

    this.desktopPendingDot = document.getElementById('desktopPendingDot');
    this.mobilePendingDot = document.getElementById('mobilePendingDot');
    this.btnStageBackToHome = document.getElementById('btnStageBackToHome');
    this.dockTrackInfo = document.getElementById('dockTrackInfo');

    // Settings View Elements
    this.btnSettingsGoogleSignIn = document.getElementById('btnSettingsGoogleSignIn');
    this.btnSettingsSignOut = document.getElementById('btnSettingsSignOut');
    this.settingsAuthSignedOut = document.getElementById('settingsAuthSignedOut');
    this.settingsAuthSignedIn = document.getElementById('settingsAuthSignedIn');
    this.settingsUserAvatar = document.getElementById('settingsUserAvatar');
    this.settingsUserName = document.getElementById('settingsUserName');
    this.settingsUserEmail = document.getElementById('settingsUserEmail');
    this.settingsAdminRow = document.getElementById('settingsAdminRow');
    this.btnOpenAdminStudioFromSettings = document.getElementById('btnOpenAdminStudioFromSettings');
    this.settingsAdminPendingBadge = document.getElementById('settingsAdminPendingBadge');
    this.btnOpenLrcEditorFromSettings = document.getElementById('btnOpenLrcEditorFromSettings');

    // Hero Spotlight Section
    this.heroCard = document.getElementById('heroCard');
    this.heroArtworkImg = document.getElementById('heroArtworkImg');
    this.btnHeroPlayBadge = document.getElementById('btnHeroPlayBadge');
    this.heroTitle = document.getElementById('heroTitle');
    this.heroArtist = document.getElementById('heroArtist');
    this.heroPlayLabel = document.getElementById('heroPlayLabel');
    this.btnHeroPlay = document.getElementById('btnHeroPlay');
    this.btnHeroOpenLyrics = document.getElementById('btnHeroOpenLyrics');

    // Home Discovery Grids & Filters
    this.homeFilterRow = document.getElementById('homeFilterRow');
    this.inputHomeSearch = document.getElementById('inputHomeSearch');
    this.gridSuggestions = document.getElementById('gridSuggestions');
    this.gridGlobalCatalog = document.getElementById('gridGlobalCatalog');
    this.gridPersonalCatalog = document.getElementById('gridPersonalCatalog');

    // Lyrics Stage & Header Elements
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

    // Lyrics Viewport
    this.lyricsViewport = document.getElementById('lyricsViewport');
    this.lyricsScrollWrap = document.getElementById('lyricsScrollWrap');
    this.noLyricsFileInput = document.getElementById('noLyricsFileInput');

    // Ambient Particles Canvas
    this.ambientParticlesCanvas = document.getElementById('ambientParticlesCanvas');
    if (this.ambientParticlesCanvas) {
      this.ambientParticles = new AmbientParticles(this.ambientParticlesCanvas);
    }

    // Audio Playback Controls
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

    // Top Bar Auth & Admin Elements
    this.btnGoogleSignIn = document.getElementById('btnGoogleSignIn');
    this.userProfilePill = document.getElementById('userProfilePill');
    this.userAvatarImg = document.getElementById('userAvatarImg');
    this.userNameLabel = document.getElementById('userNameLabel');
    this.btnSignOut = document.getElementById('btnSignOut');
    this.btnOpenAdminModal = document.getElementById('btnOpenAdminModal');
    this.adminPendingBadge = document.getElementById('adminPendingBadge');

    // Modals
    this.themeModal = document.getElementById('themeModal');
    this.btnOpenThemeModal = document.getElementById('btnOpenThemeModal');
    this.themeOptionsList = document.getElementById('themeOptionsList');

    this.trackModal = document.getElementById('trackModal');
    this.btnOpenTrackModal = document.getElementById('btnOpenTrackModal');
    this.btnOpenLrcEditor = document.getElementById('btnOpenLrcEditor');

    // Track Modal Tabs & Lists
    this.trackListView = document.getElementById('trackListView');
    this.trackFormView = document.getElementById('trackFormView');
    this.btnShowUploadForm = document.getElementById('btnShowUploadForm');
    this.btnBackToLibrary = document.getElementById('btnBackToLibrary');
    this.btnCancelTrackForm = document.getElementById('btnCancelTrackForm');
    this.trackFormModeTitle = document.getElementById('trackFormModeTitle');
    this.trackFormError = document.getElementById('trackFormError');
    this.audioRequiredBadge = document.getElementById('audioRequiredBadge');

    this.tabGlobalCatalog = document.getElementById('tabGlobalCatalog');
    this.tabOfflineLibrary = document.getElementById('tabOfflineLibrary');
    this.globalCatalogList = document.getElementById('globalCatalogList');
    this.localTracksList = document.getElementById('localTracksList');
    this.inputCatalogSearch = document.getElementById('inputCatalogSearch');

    // Cover Artwork Form Elements
    this.coverPreviewBox = document.getElementById('coverPreviewBox');
    this.coverPreviewImg = document.getElementById('coverPreviewImg');
    this.coverFileInput = document.getElementById('coverFileInput');
    this.btnUploadCoverFile = document.getElementById('btnUploadCoverFile');
    this.btnRemoveCover = document.getElementById('btnRemoveCover');

    // Custom Upload Form Elements
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

    // Public Submission Elements
    this.checkSubmitToPublic = document.getElementById('checkSubmitToPublic');
    this.publicSubmitCheckLabel = document.getElementById('publicSubmitCheckLabel');
    this.publicAudioUrlField = document.getElementById('publicAudioUrlField');
    this.inputPublicAudioUrl = document.getElementById('inputPublicAudioUrl');
    this.btnPasteR2Prefix = document.getElementById('btnPasteR2Prefix');
    this.btnTriggerPublicSubmit = document.getElementById('btnTriggerPublicSubmit');
    this.btnTriggerPublicSubmitLabel = document.getElementById('btnTriggerPublicSubmitLabel');
    this.formPublicPendingBadge = document.getElementById('formPublicPendingBadge');

    // Submission Confirmation Modal
    this.submissionConfirmModal = document.getElementById('submissionConfirmModal');
    this.confirmSubArtwork = document.getElementById('confirmSubArtwork');
    this.confirmSubTitle = document.getElementById('confirmSubTitle');
    this.confirmSubArtist = document.getElementById('confirmSubArtist');
    this.confirmSubMeta = document.getElementById('confirmSubMeta');
    this.confirmSubAudioUrl = document.getElementById('confirmSubAudioUrl');
    this.confirmSubErrorMsg = document.getElementById('confirmSubErrorMsg');
    this.btnCancelSubModal = document.getElementById('btnCancelSubModal');
    this.btnExecutePublicSubmit = document.getElementById('btnExecutePublicSubmit');
    this.btnExecutePublicSubmitLabel = document.getElementById('btnExecutePublicSubmitLabel');

    // Admin Modal Elements
    this.adminModal = document.getElementById('adminModal');
    this.adminTabSubmissions = document.getElementById('adminTabSubmissions');
    this.adminTabDirectPublish = document.getElementById('adminTabDirectPublish');
    this.adminSubmissionsSection = document.getElementById('adminSubmissionsSection');
    this.adminDirectPublishSection = document.getElementById('adminDirectPublishSection');
    this.adminSubmissionsList = document.getElementById('adminSubmissionsList');
    this.adminSubmissionsBadge = document.getElementById('adminSubmissionsBadge');

    this.adminNewArtist = document.getElementById('adminNewArtist');
    this.adminNewTitle = document.getElementById('adminNewTitle');
    this.adminNewAlbum = document.getElementById('adminNewAlbum');
    this.adminNewYear = document.getElementById('adminNewYear');
    this.adminNewAudioUrl = document.getElementById('adminNewAudioUrl');
    this.adminNewCoverUrl = document.getElementById('adminNewCoverUrl');
    this.adminNewLrc = document.getElementById('adminNewLrc');
    this.btnAdminAppendR2 = document.getElementById('btnAdminAppendR2');
    this.btnAdminPublishDirect = document.getElementById('btnAdminPublishDirect');
  }

  handleUserAuthenticated(user, isAdmin) {
    this.currentUser = user;
    this.isAdmin = isAdmin;

    if (user) {
      if (this.btnGoogleSignIn) this.btnGoogleSignIn.style.display = 'none';
      if (this.userProfilePill) {
        this.userProfilePill.style.display = 'inline-flex';
        if (this.userNameLabel) {
          this.userNameLabel.textContent = user.displayName ? user.displayName.split(' ')[0] : 'User';
        }
        if (this.userAvatarImg) {
          if (user.photoURL) {
            this.userAvatarImg.src = user.photoURL;
            this.userAvatarImg.style.display = 'block';
          } else {
            this.userAvatarImg.style.display = 'none';
          }
        }
      }
      if (this.settingsAuthSignedOut) this.settingsAuthSignedOut.style.display = 'none';
      if (this.settingsAuthSignedIn) this.settingsAuthSignedIn.style.display = 'flex';
      if (this.settingsUserName) this.settingsUserName.textContent = user.displayName || 'Google User';
      if (this.settingsUserEmail) this.settingsUserEmail.textContent = user.email || '';
      if (this.settingsUserAvatar) {
        if (user.photoURL) {
          this.settingsUserAvatar.src = user.photoURL;
          this.settingsUserAvatar.style.display = 'block';
        } else {
          this.settingsUserAvatar.style.display = 'none';
        }
      }
      if (this.settingsAdminRow) {
        this.settingsAdminRow.style.display = isAdmin ? 'flex' : 'none';
      }
    } else {
      if (this.btnGoogleSignIn) this.btnGoogleSignIn.style.display = 'inline-flex';
      if (this.userProfilePill) this.userProfilePill.style.display = 'none';
      if (this.settingsAuthSignedOut) this.settingsAuthSignedOut.style.display = 'flex';
      if (this.settingsAuthSignedIn) this.settingsAuthSignedIn.style.display = 'none';
      if (this.settingsAdminRow) this.settingsAdminRow.style.display = 'none';
    }

    // Show Admin Badge if Admin
    if (isAdmin) {
      if (this.btnOpenAdminModal) this.btnOpenAdminModal.style.display = 'inline-flex';
      if (this.publicSubmitCheckLabel) {
        this.publicSubmitCheckLabel.textContent = 'Directly publish to Global Catalog (Admin)';
      }
      this.checkPendingSubmissionsCount();
    } else {
      if (this.btnOpenAdminModal) this.btnOpenAdminModal.style.display = 'none';
      if (this.publicSubmitCheckLabel) {
        this.publicSubmitCheckLabel.textContent = 'Submit for Public Catalog (Admin Review)';
      }
    }

    this.renderHomePage();
    if (this.currentView === 'library') {
      this.renderLibraryView();
    }
  }

  initAuth() {
    try {
      // Check redirect result on mobile devices
      if (FirebaseService.checkRedirectResult) {
        FirebaseService.checkRedirectResult().then(user => {
          if (user) {
            this.handleUserAuthenticated(user, FirebaseService.isAdmin(user));
          }
        }).catch(err => console.warn('Redirect check error:', err));
      }

      FirebaseService.onAuthChanged(async (user, isAdmin) => {
        this.handleUserAuthenticated(user, isAdmin);
      });
    } catch (e) {
      console.warn('initAuth initialization error:', e);
    }
  }

  async checkPendingSubmissionsCount() {
    if (!this.isAdmin) return;
    try {
      const submissions = await FirebaseService.getSubmissions();
      const count = submissions.length;
      if (this.adminPendingBadge) {
        this.adminPendingBadge.textContent = count;
        this.adminPendingBadge.style.display = count > 0 ? 'inline-flex' : 'none';
      }
      if (this.adminSubmissionsBadge) {
        this.adminSubmissionsBadge.textContent = count;
        this.adminSubmissionsBadge.style.display = count > 0 ? 'inline-block' : 'none';
      }
      if (this.settingsAdminPendingBadge) {
        this.settingsAdminPendingBadge.textContent = count;
        this.settingsAdminPendingBadge.style.display = count > 0 ? 'inline-block' : 'none';
      }
      if (this.desktopPendingDot) {
        this.desktopPendingDot.style.display = count > 0 ? 'inline-block' : 'none';
      }
      if (this.mobilePendingDot) {
        this.mobilePendingDot.style.display = count > 0 ? 'inline-block' : 'none';
      }
    } catch (e) {
      console.warn('Pending count check error:', e);
    }
  }

  switchTab(tabId) {
    if (tabId === 'stage') tabId = 'lyrics';
    this.currentView = tabId;

    // Toggle active class on navigation tabs (desktop and mobile)
    document.querySelectorAll('.desktop-nav-tabs .nav-tab-btn, .mobile-bottom-nav .bottom-nav-item').forEach(btn => {
      if (btn.getAttribute('data-tab') === tabId) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Toggle Tab Views
    const tabMap = {
      home: this.tabViewHome || document.getElementById('tabViewHome'),
      library: this.tabViewLibrary || document.getElementById('tabViewLibrary'),
      lyrics: this.tabViewLyrics || document.getElementById('tabViewLyrics'),
      settings: this.tabViewSettings || document.getElementById('tabViewSettings')
    };

    Object.entries(tabMap).forEach(([id, el]) => {
      if (!el) return;
      if (id === tabId) {
        el.style.display = 'flex';
        el.classList.add('active');
      } else {
        el.style.display = 'none';
        el.classList.remove('active');
      }
    });

    if (tabId === 'home') {
      this.renderHomePage();
    } else if (tabId === 'library') {
      this.renderLibraryView();
    } else if (tabId === 'lyrics') {
      requestAnimationFrame(() => {
        this.syncLyrics(this.player.currentTime);
      });
    } else if (tabId === 'settings') {
      this.renderSettingsView();
    }
  }

  switchView(viewName) {
    this.switchTab(viewName);
  }

  renderLibraryView() {
    this.showTrackList();
    const query = this.inputCatalogSearch ? this.inputCatalogSearch.value.trim().toLowerCase() : '';
    if (this.currentLibraryTab === 'global') {
      this.renderPublicCatalog(query);
    } else {
      this.renderOfflineLibrary(query);
    }
  }

  renderSettingsView() {
    if (this.currentUser) {
      if (this.settingsAuthSignedOut) this.settingsAuthSignedOut.style.display = 'none';
      if (this.settingsAuthSignedIn) this.settingsAuthSignedIn.style.display = 'flex';
      if (this.settingsUserName) this.settingsUserName.textContent = this.currentUser.displayName || 'Google User';
      if (this.settingsUserEmail) this.settingsUserEmail.textContent = this.currentUser.email || '';
      if (this.settingsUserAvatar) {
        if (this.currentUser.photoURL) {
          this.settingsUserAvatar.src = this.currentUser.photoURL;
          this.settingsUserAvatar.style.display = 'block';
        } else {
          this.settingsUserAvatar.style.display = 'none';
        }
      }
      if (this.settingsAdminRow) {
        this.settingsAdminRow.style.display = this.isAdmin ? 'flex' : 'none';
      }
    } else {
      if (this.settingsAuthSignedOut) this.settingsAuthSignedOut.style.display = 'flex';
      if (this.settingsAuthSignedIn) this.settingsAuthSignedIn.style.display = 'none';
      if (this.settingsAdminRow) this.settingsAdminRow.style.display = 'none';
    }

    this.initThemeSystem();
  }

  openAdminModal() {
    if (this.adminModal) {
      this.adminModal.classList.add('active');
      this.loadAdminSubmissions();
    }
  }

  initEvents() {
    // Tab Navigation (Desktop & Mobile-First)
    document.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = btn.getAttribute('data-tab');
        if (tabId) this.switchTab(tabId);
      });
    });

    if (this.btnStageBackToHome) {
      this.btnStageBackToHome.addEventListener('click', () => this.switchTab('home'));
    }
    // Clicking dock mini-player opens the Lyrics Stage
    if (this.dockTrackInfo) {
      this.dockTrackInfo.addEventListener('click', () => this.switchTab('lyrics'));
    }
    if (this.btnHeroOpenLyrics) {
      this.btnHeroOpenLyrics.addEventListener('click', () => this.switchTab('lyrics'));
    }
    if (this.userProfilePill) {
      this.userProfilePill.addEventListener('click', () => this.switchTab('settings'));
    }

    // Settings View Triggers
    if (this.btnSettingsGoogleSignIn) {
      this.btnSettingsGoogleSignIn.addEventListener('click', async () => {
        try {
          const user = await FirebaseService.loginWithGoogle();
          if (user) {
            this.handleUserAuthenticated(user, FirebaseService.isAdmin(user));
          }
        } catch (err) {
          alert('Google Sign-In: ' + (err.message || 'Please check your internet connection'));
        }
      });
    }
    if (this.btnSettingsSignOut) {
      this.btnSettingsSignOut.addEventListener('click', async () => {
        await FirebaseService.logout();
        this.handleUserAuthenticated(null, false);
      });
    }
    if (this.btnOpenAdminStudioFromSettings) {
      this.btnOpenAdminStudioFromSettings.addEventListener('click', () => {
        this.openAdminModal();
      });
    }
    if (this.btnOpenLrcEditorFromSettings) {
      this.btnOpenLrcEditorFromSettings.addEventListener('click', () => {
        if (this.lrcEditor) {
          this.lrcEditor.open(this.currentTrack ? (this.currentTrack.lrc || '') : '');
        }
      });
    }

    // Settings Themes Accordion Toggle
    const btnToggleThemes = document.getElementById('btnToggleThemesAccordion');
    const themesCollapseBody = document.getElementById('themesCollapseBody');
    const themesChevron = document.getElementById('themesChevronIcon');
    if (btnToggleThemes && themesCollapseBody) {
      btnToggleThemes.addEventListener('click', () => {
        const isCollapsed = themesCollapseBody.style.display === 'none' || !themesCollapseBody.style.display;
        if (isCollapsed) {
          themesCollapseBody.style.display = 'block';
          if (themesChevron) themesChevron.style.transform = 'rotate(180deg)';
        } else {
          themesCollapseBody.style.display = 'none';
          if (themesChevron) themesChevron.style.transform = 'rotate(0deg)';
        }
      });
    }

    // Hero Spotlight Controls
    const handleHeroPlay = async () => {
      if (!this.currentTrack && this.publicTracks.length > 0) {
        await this.loadTrack(this.publicTracks[0], true);
      } else if (this.currentTrack) {
        this.player.togglePlay();
      }
      this.updateHeroState();
    };

    if (this.btnHeroPlay) this.btnHeroPlay.addEventListener('click', handleHeroPlay);
    if (this.btnHeroPlayBadge) this.btnHeroPlayBadge.addEventListener('click', handleHeroPlay);

    // Filter Chips
    if (this.homeFilterRow) {
      this.homeFilterRow.addEventListener('click', (e) => {
        const chip = e.target.closest('.filter-chip');
        if (!chip) return;
        this.homeFilterRow.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.activeFilter = chip.getAttribute('data-filter') || 'all';
        this.renderHomePage();
      });
    }

    // Search Input
    if (this.inputHomeSearch) {
      this.inputHomeSearch.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.trim().toLowerCase();
        this.renderHomePage();
      });
    }

    // Play / Pause
    if (this.btnPlayPause) {
      this.btnPlayPause.addEventListener('click', () => {
        if (!this.currentTrack) {
          if (this.publicTracks.length > 0) {
            this.loadTrack(this.publicTracks[0], true);
          } else {
            this.switchTab('library');
          }
          return;
        }
        this.player.togglePlay();
        this.updateHeroState();
      });
    }

    // Rewind / Forward 5s
    if (this.btnRewind) {
      this.btnRewind.addEventListener('click', () => {
        if (this.currentTrack) this.player.seek(this.player.currentTime - 5);
      });
    }
    if (this.btnForward) {
      this.btnForward.addEventListener('click', () => {
        if (this.currentTrack) this.player.seek(this.player.currentTime + 5);
      });
    }

    // Playback Speed Toggle
    if (this.btnSpeed) {
      const speeds = [1.0, 1.25, 1.5, 0.75];
      let speedIdx = 0;
      this.btnSpeed.addEventListener('click', () => {
        speedIdx = (speedIdx + 1) % speeds.length;
        const spd = speeds[speedIdx];
        this.player.setPlaybackRate(spd);
        this.btnSpeed.textContent = `${spd}x`;
      });
    }

    // Audio Player State Listeners
    this.player.onStateChange = (state) => {
      if (state === 'playing') {
        if (this.playIcon) this.playIcon.style.display = 'none';
        if (this.pauseIcon) this.pauseIcon.style.display = 'block';
        if (this.vinylDisc) {
          this.vinylDisc.classList.remove('paused');
          this.vinylDisc.classList.add('spinning');
        }
      } else {
        if (this.playIcon) this.playIcon.style.display = 'block';
        if (this.pauseIcon) this.pauseIcon.style.display = 'none';
        if (this.vinylDisc) this.vinylDisc.classList.add('paused');
      }
      this.updateHeroState();
    };

    this.player.onTimeUpdate = (currentTime, duration) => {
      if (!this.isScrubbing) {
        this.updateTimeline(currentTime, duration);
      }
      if (this.currentView === 'stage' || this.currentView === 'lyrics') {
        this.syncLyrics(currentTime);
      }
    };

    // Smart Queue: When a song ends, play the next suggested track
    this.player.onEnded = async () => {
      if (this.playIcon) this.playIcon.style.display = 'block';
      if (this.pauseIcon) this.pauseIcon.style.display = 'none';
      if (this.vinylDisc) this.vinylDisc.classList.remove('spinning');
      this.syncLyrics(0);

      const allTracks = [...this.publicTracks, ...this.tracks];
      if (allTracks.length > 1 && this.currentTrack) {
        const currentIndex = allTracks.findIndex(t => t.id === this.currentTrack.id);
        const nextTrack = allTracks[(currentIndex + 1) % allTracks.length];
        if (nextTrack) {
          await this.loadTrack(nextTrack, true);
        }
      }
    };

    // Volume & Mute
    if (this.volumeSlider) {
      let lastVolume = 0.8;
      this.volumeSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.player.setVolume(val);
        if (val > 0) lastVolume = val;
      });

      if (this.btnMute) {
        this.btnMute.addEventListener('click', () => {
          if (this.player.volume > 0) {
            this.player.setVolume(0);
            this.volumeSlider.value = 0;
          } else {
            this.player.setVolume(lastVolume);
            this.volumeSlider.value = lastVolume;
          }
        });
      }
    }

    // Timeline Scrubber
    if (this.scrubberTrack) {
      const seekAtClientX = (clientX) => {
        if (!this.currentTrack || !this.player.duration) return;
        const rect = this.scrubberTrack.getBoundingClientRect();
        const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        this.player.seek(pos * this.player.duration);
      };

      this.scrubberTrack.addEventListener('click', (e) => seekAtClientX(e.clientX));
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
      });
    }

    // Fullscreen Toggle
    if (this.btnToggleFullscreen) {
      this.btnToggleFullscreen.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      });
    }

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.player.togglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        if (this.currentTrack) this.player.seek(this.player.currentTime - 5);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        if (this.currentTrack) this.player.seek(this.player.currentTime + 5);
      } else if (e.code === 'KeyF') {
        if (this.btnToggleFullscreen) this.btnToggleFullscreen.click();
      }
    });

    // Auth Buttons (Top Bar)
    if (this.btnGoogleSignIn) {
      this.btnGoogleSignIn.addEventListener('click', async () => {
        try {
          const user = await FirebaseService.loginWithGoogle();
          if (user) {
            this.handleUserAuthenticated(user, FirebaseService.isAdmin(user));
          }
        } catch (err) {
          alert('Sign In: ' + (err.message || 'Please check your internet connection'));
        }
      });
    }

    if (this.btnSignOut) {
      this.btnSignOut.addEventListener('click', async () => {
        await FirebaseService.logout();
        this.handleUserAuthenticated(null, false);
      });
    }

    if (this.btnOpenAdminModal) {
      this.btnOpenAdminModal.addEventListener('click', () => {
        this.openAdminModal();
      });
    }

    // Modal Triggers (Legacy / Safe guards)
    if (this.btnOpenThemeModal && this.themeModal) {
      this.btnOpenThemeModal.addEventListener('click', () => this.themeModal.classList.add('active'));
    }
    if (this.btnOpenTrackModal && this.trackModal) {
      this.btnOpenTrackModal.addEventListener('click', () => {
        this.trackModal.classList.add('active');
        this.showTrackList();
      });
    }
    if (this.btnOpenLrcEditor && this.lrcEditor) {
      this.btnOpenLrcEditor.addEventListener('click', () => {
        this.lrcEditor.open(this.currentTrack ? (this.currentTrack.lrc || '') : '');
      });
    }

    // Generic Modal Close Buttons
    document.querySelectorAll('.modal-close-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.getAttribute('data-close');
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('active');
      });
    });

    // Modal Backdrop Close
    [this.themeModal, this.trackModal, this.adminModal].forEach(modal => {
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) modal.classList.remove('active');
        });
      }
    });

    // Library Tab Switchers in Library View
    if (this.tabGlobalCatalog) {
      this.tabGlobalCatalog.addEventListener('click', () => this.switchLibraryTab('global'));
    }
    if (this.tabOfflineLibrary) {
      this.tabOfflineLibrary.addEventListener('click', () => this.switchLibraryTab('offline'));
    }

    if (this.inputCatalogSearch) {
      this.inputCatalogSearch.addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        if (this.currentLibraryTab === 'global') {
          this.renderPublicCatalog(query);
        } else {
          this.renderOfflineLibrary(query);
        }
      });
    }

    // Upload Form View Switchers
    if (this.btnShowUploadForm) {
      this.btnShowUploadForm.addEventListener('click', () => this.showTrackForm());
    }
    if (this.btnBackToLibrary) {
      this.btnBackToLibrary.addEventListener('click', () => this.showTrackList());
    }
    if (this.btnCancelTrackForm) {
      this.btnCancelTrackForm.addEventListener('click', () => this.showTrackList());
    }

    if (this.checkSubmitToPublic) {
      this.checkSubmitToPublic.addEventListener('change', () => {
        if (this.publicAudioUrlField) {
          this.publicAudioUrlField.style.display = this.checkSubmitToPublic.checked ? 'block' : 'none';
        }
        this.updatePublicSubmitButtonState();
      });
    }

    if (this.inputPublicAudioUrl) {
      this.inputPublicAudioUrl.addEventListener('input', () => {
        this.updatePublicSubmitButtonState();
      });
    }

    if (this.btnPasteR2Prefix) {
      this.btnPasteR2Prefix.addEventListener('click', () => {
        if (this.inputPublicAudioUrl) {
          const current = this.inputPublicAudioUrl.value.trim();
          if (!current || !current.startsWith('http')) {
            const fileName = (this.selectedAudioFile ? this.selectedAudioFile.name : (this.inputCustomTitle && this.inputCustomTitle.value.trim() ? `${this.inputCustomTitle.value.trim()}.mp3` : 'song.mp3')).replace(/\s+/g, '_');
            this.inputPublicAudioUrl.value = `${R2_PUBLIC_BASE}/${fileName}`;
          }
          this.inputPublicAudioUrl.focus();
          this.updatePublicSubmitButtonState();
        }
      });
    }

    if (this.btnTriggerPublicSubmit) {
      this.btnTriggerPublicSubmit.addEventListener('click', () => {
        this.openSubmissionConfirmModal();
      });
    }

    if (this.btnCancelSubModal) {
      this.btnCancelSubModal.addEventListener('click', () => {
        if (this.submissionConfirmModal) this.submissionConfirmModal.classList.remove('active');
      });
    }

    if (this.btnExecutePublicSubmit) {
      this.btnExecutePublicSubmit.addEventListener('click', async () => {
        await this.handleExecutePublicSubmit();
      });
    }

    // Cover Artwork Picker
    if (this.coverPreviewBox && this.coverFileInput) {
      this.coverPreviewBox.addEventListener('click', () => this.coverFileInput.click());
    }
    if (this.btnUploadCoverFile && this.coverFileInput) {
      this.btnUploadCoverFile.addEventListener('click', () => this.coverFileInput.click());
    }
    if (this.coverFileInput) {
      this.coverFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (evt) => {
            this.selectedCoverDataUrl = evt.target.result;
            if (this.coverPreviewImg) this.coverPreviewImg.src = evt.target.result;
          };
          reader.readAsDataURL(file);
        }
      });
    }

    if (this.btnRemoveCover) {
      this.btnRemoveCover.addEventListener('click', () => {
        this.selectedCoverDataUrl = '';
        if (this.coverPreviewImg) this.coverPreviewImg.src = 'assets/weleta_cover.jpg';
        if (this.coverFileInput) this.coverFileInput.value = '';
      });
    }

    // Audio Dropzone & File Pick
    if (this.audioDropzone && this.audioFileInput) {
      this.audioDropzone.addEventListener('click', () => this.audioFileInput.click());
      ['dragenter', 'dragover'].forEach(name => {
        this.audioDropzone.addEventListener(name, (e) => {
          e.preventDefault();
          this.audioDropzone.style.borderColor = 'rgba(255,255,255,0.7)';
          this.audioDropzone.style.background = 'rgba(255,255,255,0.08)';
        });
      });
      ['dragleave', 'drop'].forEach(name => {
        this.audioDropzone.addEventListener(name, (e) => {
          e.preventDefault();
          this.audioDropzone.style.borderColor = '';
          this.audioDropzone.style.background = '';
        });
      });

      this.audioDropzone.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
          const file = e.dataTransfer.files[0];
          if (file.type.startsWith('audio/') || file.name.match(/\.(mp3|wav|ogg|m4a|aac|flac)$/i)) {
            this.selectedAudioFile = file;
            if (this.audioDropzoneLabel) this.audioDropzoneLabel.textContent = `Selected: ${file.name}`;
            if (this.inputCustomTitle && !this.inputCustomTitle.value) {
              const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
              this.inputCustomTitle.value = nameWithoutExt;
            }
          }
        }
      });
    }

    if (this.audioFileInput) {
      this.audioFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          if (this.audioDropzoneLabel) this.audioDropzoneLabel.textContent = `Selected: ${file.name}`;
          this.selectedAudioFile = file;
          if (this.inputCustomTitle && !this.inputCustomTitle.value) {
            const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
            this.inputCustomTitle.value = nameWithoutExt;
          }
        }
      });
    }

    // LRC File Pick
    if (this.btnUploadLrc && this.lrcFileInput) {
      this.btnUploadLrc.addEventListener('click', () => this.lrcFileInput.click());
    }
    if (this.lrcFileInput) {
      this.lrcFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (evt) => {
            if (this.inputCustomLrc) this.inputCustomLrc.value = evt.target.result;
          };
          reader.readAsText(file);
        }
      });
    }

    // Viewport LRC Upload
    if (this.noLyricsFileInput) {
      this.noLyricsFileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file && this.currentTrack) {
          const text = await file.text();
          this.currentTrack.lrc = text;
          await Storage.saveTrack(this.currentTrack);
          this.parsedLyrics = LyricsParser.parse(text);
          this.renderLyrics();
          this.syncLyrics(this.player.currentTime);
        }
      });
    }

    // Apply Track Form Button
    if (this.btnApplyCustomTrack) {
      this.btnApplyCustomTrack.addEventListener('click', () => this.applyCustomTrack());
    }

    // Admin Modal Tabs
    if (this.adminTabSubmissions) {
      this.adminTabSubmissions.addEventListener('click', () => {
        this.adminTabSubmissions.classList.add('active');
        this.adminTabDirectPublish.classList.remove('active');
        this.adminSubmissionsSection.style.display = 'block';
        this.adminDirectPublishSection.style.display = 'none';
        this.loadAdminSubmissions();
      });
    }

    if (this.adminTabDirectPublish) {
      this.adminTabDirectPublish.addEventListener('click', () => {
        this.adminTabDirectPublish.classList.add('active');
        this.adminTabSubmissions.classList.remove('active');
        this.adminDirectPublishSection.style.display = 'flex';
        this.adminSubmissionsSection.style.display = 'none';
      });
    }

    if (this.btnAdminAppendR2) {
      this.btnAdminAppendR2.addEventListener('click', () => {
        this.adminNewAudioUrl.value = `${R2_PUBLIC_BASE}/`;
        this.adminNewAudioUrl.focus();
      });
    }

    if (this.btnAdminPublishDirect) {
      this.btnAdminPublishDirect.addEventListener('click', async () => {
        await this.handleAdminDirectPublish();
      });
    }
  }

  // --------------------------------------------------------------------------
  // Music Suggestion Engine & Home Page Rendering
  // --------------------------------------------------------------------------
  updateHeroState() {
    if (!this.heroCard) return;
    const isPlaying = this.player.isPlaying;
    if (this.heroPlayLabel) {
      this.heroPlayLabel.textContent = isPlaying ? 'Pause Track' : 'Play Track';
    }
    if (this.btnHeroPlayBadge) {
      this.btnHeroPlayBadge.innerHTML = isPlaying 
        ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>' 
        : '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
    }
  }

  renderHomePage() {
    if (!this.homeExploreView) return;

    // 1. Featured Spotlight
    const spotlightTrack = this.currentTrack || (this.publicTracks.length > 0 ? this.publicTracks[0] : (this.tracks.length > 0 ? this.tracks[0] : null));
    if (spotlightTrack) {
      if (this.heroArtworkImg) {
        this.heroArtworkImg.src = spotlightTrack.cover || 'assets/weleta_cover.jpg';
      }
      if (this.heroTitle) this.heroTitle.textContent = spotlightTrack.title;
      if (this.heroArtist) this.heroArtist.textContent = spotlightTrack.artist;
      this.updateHeroState();
    }

    // 2. Filter & Match Tracks
    const allTracks = [...this.publicTracks, ...this.tracks];
    let filtered = allTracks;

    if (this.searchQuery) {
      const q = this.searchQuery;
      filtered = filtered.filter(t =>
        (t.title && t.title.toLowerCase().includes(q)) ||
        (t.artist && t.artist.toLowerCase().includes(q)) ||
        (t.album && t.album.toLowerCase().includes(q))
      );
    }

    if (this.activeFilter === 'suggested') {
      // Suggestion Engine: Prioritizes tracks with synced lyrics, distinct artists, or recent additions
      filtered = filtered.filter(t => t.lrc && t.lrc.length > 10);
    } else if (this.activeFilter === 'classic') {
      filtered = filtered.filter(t => (t.album && t.album.toLowerCase().includes('classic')) || (parseInt(t.year) < 2010));
    } else if (this.activeFilter === 'pop') {
      filtered = filtered.filter(t => !t.year || parseInt(t.year) >= 2010);
    } else if (this.activeFilter === 'lrc') {
      filtered = filtered.filter(t => t.lrc && t.lrc.length > 5);
    } else if (this.activeFilter === 'offline') {
      filtered = this.tracks;
    }

    // 3. Populate Grids
    this.renderMusicGrid(this.gridSuggestions, this.getSmartSuggestions(filtered), 'No suggestions matching your filter.');
    this.renderMusicGrid(this.gridGlobalCatalog, this.publicTracks.filter(t => filtered.includes(t)), 'No cloud tracks available. Use Admin Studio to publish tracks to R2!');
    this.renderMusicGrid(this.gridPersonalCatalog, this.tracks.filter(t => filtered.includes(t)), 'No offline tracks saved. Download songs from the catalog or upload your own!');
  }

  getSmartSuggestions(tracksList) {
    if (!tracksList || tracksList.length === 0) return [];
    // Smart Suggestion Logic:
    // 1. Give highest weight to songs with rich synced lyrics
    // 2. Give weight to songs matching the current playing song's artist or era
    // 3. Shuffle or rotate for engaging fresh discovery
    const sorted = [...tracksList].sort((a, b) => {
      let scoreA = 0;
      let scoreB = 0;
      if (a.lrc && a.lrc.length > 20) scoreA += 5;
      if (b.lrc && b.lrc.length > 20) scoreB += 5;
      if (this.currentTrack) {
        if (a.artist === this.currentTrack.artist) scoreA += 3;
        if (b.artist === this.currentTrack.artist) scoreB += 3;
      }
      return scoreB - scoreA;
    });
    return sorted.slice(0, 8);
  }

  renderMusicGrid(container, tracks, emptyMessage) {
    if (!container) return;
    container.innerHTML = '';

    if (!tracks || tracks.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 2rem; text-align: center; color: var(--color-text-dim); font-size: 0.88rem; background: rgba(255,255,255,0.02); border-radius: 14px; border: 1px dashed rgba(255,255,255,0.08);">
          ${emptyMessage}
        </div>
      `;
      return;
    }

    tracks.forEach(track => {
      const isCurrent = this.currentTrack && this.currentTrack.id === track.id;
      const isPlaying = isCurrent && this.player.isPlaying;

      const card = document.createElement('div');
      card.className = `music-card ${isCurrent ? 'playing' : ''}`;
      card.innerHTML = `
        <div class="card-art-wrap">
          <img src="${track.cover || 'assets/weleta_cover.jpg'}" alt="${track.title}" class="card-art-img" crossorigin="anonymous" onerror="this.src='assets/weleta_cover.jpg'">
          <div class="card-play-overlay">
            <div class="card-play-icon">${isPlaying ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>' : '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>'}</div>
          </div>
        </div>
        <div class="card-meta">
          <div class="card-title" title="${track.title}">${track.title}</div>
          <div class="card-artist" title="${track.artist}">${track.artist}</div>
          <div class="card-tag-row">
            <span class="card-tag">${track.lrc ? 'Synced' : 'Audio'}</span>
            <div class="card-actions-row">
              <button class="card-btn-action btn-card-download" title="Save for Offline"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
            </div>
          </div>
        </div>
      `;

      // Play on card click
      card.addEventListener('click', async () => {
        if (isCurrent) {
          this.player.togglePlay();
        } else {
          await this.loadTrack(track, true);
        }
        this.renderHomePage();
      });

      // Download button
      const dlBtn = card.querySelector('.btn-card-download');
      dlBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        dlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
        try {
          await Storage.downloadTrackForOffline(track);
          dlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
          dlBtn.title = 'Saved Offline';
          this.tracks = await Storage.getAllTracks();
        } catch (err) {
          dlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
          setTimeout(() => { dlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'; }, 2000);
        }
      });

      container.appendChild(card);
    });
  }

  // --------------------------------------------------------------------------
  // Track Loading & Sync
  // --------------------------------------------------------------------------
  async loadTrack(track, autoPlay = true) {
    this.currentTrack = track;
    Storage.setLastTrackId(track.id);

    // Update Header Display on Lyrics Stage
    if (this.artistAmharic) this.artistAmharic.textContent = track.artist || 'Unknown Artist';
    if (this.artistEnglish) this.artistEnglish.textContent = track.artistEn || track.artist || 'Unknown Artist';
    if (this.songTitleAmharic) this.songTitleAmharic.textContent = track.title || 'Untitled Track';
    if (this.albumTitle) this.albumTitle.textContent = track.album || 'My Album';
    if (this.albumYear) this.albumYear.textContent = track.year || '2024';

    // Update Images & Mini Player Dock
    const coverUrl = track.cover || 'assets/weleta_cover.jpg';
    const discUrl = track.discCenter || coverUrl;
    if (this.discArtwork) this.discArtwork.src = discUrl;
    if (this.playerMiniArt) this.playerMiniArt.src = coverUrl;
    if (this.playerMiniTitle) this.playerMiniTitle.textContent = track.title;
    if (this.playerMiniArtist) this.playerMiniArtist.textContent = track.artist;

    // Load Audio in Engine
    this.player.loadTrack(track);

    // Dynamic color extraction with mobile blob safety
    PaletteExtractor.extractFromImage(coverUrl).then(palette => {
      PaletteExtractor.applyToElement(this.appEl, palette);
    });

    // Parse Lyrics
    this.parsedLyrics = LyricsParser.parse(track.lrc || '');
    this.renderLyrics();
    this.syncLyrics(0);
    this.updateTimeline(0, track.duration || 180);

    if (autoPlay) {
      this.player.play();
    }

    this.updateHeroState();
  }

  renderEmptyLibraryState() {
    this.currentTrack = null;
    this.parsedLyrics = [];

    PaletteExtractor.applyToElement(this.appEl, PaletteExtractor.getDefaultPalette());

    if (this.artistAmharic) this.artistAmharic.textContent = 'የሙዚቃ ማጫወቻ';
    if (this.artistEnglish) this.artistEnglish.textContent = 'ETHIO LYRICS PLAYER';
    if (this.songTitleAmharic) this.songTitleAmharic.textContent = 'ሙዚቃ ይምረጡ';
    if (this.albumTitle) this.albumTitle.textContent = 'Library';
    if (this.albumYear) this.albumYear.textContent = new Date().getFullYear().toString();

    if (this.playerMiniTitle) this.playerMiniTitle.textContent = 'No Track Loaded';
    if (this.playerMiniArtist) this.playerMiniArtist.textContent = 'Select a track to begin';

    if (this.lyricsScrollWrap) {
      this.lyricsScrollWrap.innerHTML = `
        <div class="lyrics-no-content">
          <div class="no-lyrics-icon">
            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
          </div>
          <div class="no-lyrics-title">No Tracks in Library</div>
          <div class="no-lyrics-subtitle">Select a song from Explore or upload an audio song to start listening with synchronized lyrics.</div>
          <div class="no-lyrics-actions">
            <button id="btnEmptyUploadTrack" class="btn-pill btn-primary-action">
              <span>Upload Song &amp; Lyrics</span>
            </button>
          </div>
        </div>
      `;
      const btn = document.getElementById('btnEmptyUploadTrack');
      if (btn) {
        btn.addEventListener('click', () => {
          this.switchTab('library');
          this.showTrackForm();
        });
      }
      this.lyricsScrollWrap.style.transform = 'none';
    }
  }

  renderLyrics() {
    if (!this.lyricsScrollWrap) return;
    this.lyricsScrollWrap.innerHTML = '';
    this.activeLyricIndex = -1;

    if (!this.parsedLyrics || this.parsedLyrics.length === 0) {
      this.lyricsScrollWrap.innerHTML = `
        <div class="lyrics-no-content">
          <div class="no-lyrics-icon">
            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </div>
          <div class="no-lyrics-title">Lyrics Unavailable</div>
          <div class="no-lyrics-subtitle">No synchronized lyrics attached to "${this.currentTrack ? this.currentTrack.title : 'this song'}". You can upload an .LRC file or use the editor to create synchronized lyrics!</div>
          <div class="no-lyrics-actions">
            <button id="btnNoLyricsUploadLrc" class="btn-pill btn-primary-action">
              <span>Upload .LRC File</span>
            </button>
            <button id="btnNoLyricsOpenEditor" class="btn-pill btn-secondary-action">
              <span>Add / Sync Lyrics</span>
            </button>
          </div>
        </div>
      `;

      const upBtn = document.getElementById('btnNoLyricsUploadLrc');
      if (upBtn) {
        upBtn.addEventListener('click', () => {
          if (this.noLyricsFileInput) this.noLyricsFileInput.click();
        });
      }
      const editBtn = document.getElementById('btnNoLyricsOpenEditor');
      if (editBtn) {
        editBtn.addEventListener('click', () => {
          this.lrcEditor.open(this.currentTrack ? (this.currentTrack.lrc || '') : '');
        });
      }

      this.lyricsScrollWrap.style.transform = 'none';
      return;
    }

    this.parsedLyrics.forEach((line, index) => {
      const lineEl = document.createElement('div');
      lineEl.className = 'lyric-line distant';
      lineEl.dataset.time = line.time;
      lineEl.dataset.index = index;
      lineEl.textContent = line.text;

      lineEl.addEventListener('click', () => {
        this.player.seek(line.time);
        if (!this.player.isPlaying) this.player.play();
      });

      this.lyricsScrollWrap.appendChild(lineEl);
    });
  }

  syncLyrics(currentTime) {
    if (!this.parsedLyrics || this.parsedLyrics.length === 0 || !this.lyricsScrollWrap) return;

    const newIndex = LyricsParser.getActiveIndex(this.parsedLyrics, currentTime);
    if (newIndex === this.activeLyricIndex && this.activeLyricIndex !== -1) return;

    const oldIndex = this.activeLyricIndex;
    this.activeLyricIndex = newIndex;
    const lines = this.lyricsScrollWrap.children;
    if (!lines || lines.length === 0) return;

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

    if (this._scrollRafId) cancelAnimationFrame(this._scrollRafId);
    this._scrollRafId = requestAnimationFrame(() => {
      if (!this.lyricsViewport) return;
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
    if (!this.currentTimeLabel || !this.durationLabel || !this.scrubberFill) return;
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

  // --------------------------------------------------------------------------
  // Catalog & Submissions Management
  // --------------------------------------------------------------------------
  async loadPublicCatalog() {
    try {
      const tracks = await FirebaseService.getPublicTracks();
      this.publicTracks = tracks;
    } catch (e) {
      console.warn('Could not fetch public catalog from Firestore (offline):', e);
      this.publicTracks = [];
    }
  }

  switchLibraryTab(tab) {
    this.currentLibraryTab = tab;
    if (tab === 'global') {
      if (this.tabGlobalCatalog) this.tabGlobalCatalog.classList.add('active');
      if (this.tabOfflineLibrary) this.tabOfflineLibrary.classList.remove('active');
      if (this.globalCatalogList) this.globalCatalogList.style.display = 'flex';
      if (this.localTracksList) this.localTracksList.style.display = 'none';
      this.renderPublicCatalog(this.inputCatalogSearch ? this.inputCatalogSearch.value : '');
    } else {
      if (this.tabOfflineLibrary) this.tabOfflineLibrary.classList.add('active');
      if (this.tabGlobalCatalog) this.tabGlobalCatalog.classList.remove('active');
      if (this.localTracksList) this.localTracksList.style.display = 'flex';
      if (this.globalCatalogList) this.globalCatalogList.style.display = 'none';
      this.renderOfflineLibrary(this.inputCatalogSearch ? this.inputCatalogSearch.value : '');
    }
  }

  async renderPublicCatalog(filterText = '') {
    if (!this.globalCatalogList) return;
    this.globalCatalogList.innerHTML = '';

    let tracksToDisplay = this.publicTracks;
    if (filterText) {
      const q = filterText.toLowerCase();
      tracksToDisplay = tracksToDisplay.filter(t =>
        (t.title && t.title.toLowerCase().includes(q)) ||
        (t.artist && t.artist.toLowerCase().includes(q)) ||
        (t.album && t.album.toLowerCase().includes(q))
      );
    }

    if (!tracksToDisplay || tracksToDisplay.length === 0) {
      this.globalCatalogList.innerHTML = `
        <div style="text-align:center; padding:2rem; color:var(--color-text-dim); font-size:0.88rem;">
          ${this.publicTracks.length === 0 ? 'No songs currently in the Global Catalog.' : `No songs match "${filterText}"`}
        </div>
      `;
      return;
    }

    for (const song of tracksToDisplay) {
      const isCurrent = this.currentTrack && this.currentTrack.id === song.id;
      const isOfflineReady = await Storage.hasTrack(song.id);

      const card = document.createElement('div');
      card.className = `theme-card-option ${isCurrent ? 'active' : ''}`;
      card.style.padding = '0.75rem 1rem';
      card.innerHTML = `
        <div style="display:flex; align-items:center; gap:0.75rem; flex:1; min-width:0;">
          <img src="${song.cover || 'assets/weleta_cover.jpg'}" class="track-thumb-img" alt="${song.title}" crossorigin="anonymous" onerror="this.src='assets/weleta_cover.jpg'">
          <div style="overflow:hidden;">
            <div style="font-weight:600; font-size:0.92rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${song.title} - ${song.artist}
            </div>
            <div style="font-size:0.75rem; color:var(--color-text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${song.album || 'Single'} (${song.year || '2024'}) • ${song.lrc ? 'Synced Lyrics' : 'No Lyrics'}
            </div>
          </div>
        </div>
        <div style="display:flex; gap:0.4rem; flex-shrink:0; align-items:center;">
          <button class="btn-pill btn-play-public" style="font-size:0.75rem; padding:0.35rem 0.75rem;">
            ${isCurrent && this.player.isPlaying ? 'Playing' : 'Play'}
          </button>
          <button class="btn-pill btn-download-offline ${isOfflineReady ? 'downloaded' : ''}" data-id="${song.id}">
            ${isOfflineReady ? 'Saved' : 'Download'}
          </button>
          ${this.isAdmin ? `<button class="btn-pill btn-delete-public" style="font-size:0.75rem; padding:0.35rem 0.55rem; color:#ff6b6b;" title="Delete from Global Catalog">&times;</button>` : ''}
        </div>
      `;

      card.querySelector('.btn-play-public').addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.loadTrack(song, true);
        if (this.trackModal) this.trackModal.classList.remove('active');
        this.renderHomePage();
      });

      const dlBtn = card.querySelector('.btn-download-offline');
      dlBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (dlBtn.classList.contains('downloaded')) return;
        dlBtn.textContent = 'Saving...';
        try {
          await Storage.downloadTrackForOffline(song);
          dlBtn.textContent = 'Saved';
          dlBtn.classList.add('downloaded');
          this.tracks = await Storage.getAllTracks();
          this.renderHomePage();
        } catch (err) {
          dlBtn.textContent = 'Failed';
          setTimeout(() => { dlBtn.textContent = 'Download'; }, 2000);
        }
      });

      if (this.isAdmin) {
        const delBtn = card.querySelector('.btn-delete-public');
        if (delBtn) {
          delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm(`Remove "${song.title}" from Global Cloud Catalog?`)) {
              await FirebaseService.deletePublicTrack(song.id);
              await this.loadPublicCatalog();
              this.renderPublicCatalog();
              this.renderHomePage();
            }
          });
        }
      }

      card.addEventListener('click', async () => {
        await this.loadTrack(song, true);
        this.trackModal.classList.remove('active');
        this.renderHomePage();
      });

      this.globalCatalogList.appendChild(card);
    }
  }

  renderOfflineLibrary(filterText = '') {
    if (!this.localTracksList) return;
    this.localTracksList.innerHTML = '';

    let tracksToDisplay = this.tracks;
    if (filterText) {
      const q = filterText.toLowerCase();
      tracksToDisplay = tracksToDisplay.filter(t =>
        (t.title && t.title.toLowerCase().includes(q)) ||
        (t.artist && t.artist.toLowerCase().includes(q)) ||
        (t.album && t.album.toLowerCase().includes(q))
      );
    }

    if (!tracksToDisplay || tracksToDisplay.length === 0) {
      this.localTracksList.innerHTML = `
        <div class="empty-library-state">
          <div style="margin-bottom:0.25rem;">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="opacity:0.6;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <div style="font-weight:600; font-size:1rem; color:#fff;">No Offline Tracks Yet</div>
          <div style="font-size:0.82rem; color:var(--color-text-dim); max-width:340px; margin-top:0.25rem; line-height:1.4;">
            Upload your own audio files or download songs from the Global Catalog to listen offline.
          </div>
          <button id="btnModalAddFirstTrack" class="btn-pill btn-primary-action" style="margin-top:0.75rem; padding:0.5rem 1.1rem; font-size:0.85rem;">
            + Upload Your First Song
          </button>
        </div>
      `;
      const addBtn = this.localTracksList.querySelector('#btnModalAddFirstTrack');
      if (addBtn) addBtn.addEventListener('click', () => this.showTrackForm());
      return;
    }

    tracksToDisplay.forEach(song => {
      const isCurrent = this.currentTrack && this.currentTrack.id === song.id;
      const card = document.createElement('div');
      card.className = `theme-card-option ${isCurrent ? 'active' : ''}`;
      card.style.padding = '0.75rem 1rem';
      card.innerHTML = `
        <div style="display:flex; align-items:center; gap:0.75rem; flex:1; min-width:0;">
          <img src="${song.cover || 'assets/weleta_cover.jpg'}" class="track-thumb-img" alt="${song.title}" crossorigin="anonymous" onerror="this.src='assets/weleta_cover.jpg'">
          <div style="overflow:hidden;">
            <div style="font-weight:600; font-size:0.92rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${song.title} - ${song.artist}
            </div>
            <div style="font-size:0.75rem; color:var(--color-text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${song.album || 'Single'} (${song.year || '2024'}) • ${song.isDownloaded ? 'Downloaded' : 'Custom Upload'}
              ${song.submissionStatus === 'pending' ? ' • <span style="color:#f4a261; font-weight:600;">Pending Review</span>' : ''}
              ${song.submissionStatus === 'published' ? ' • <span style="color:#10b981; font-weight:600;">Published</span>' : ''}
            </div>
          </div>
        </div>
        <div style="display:flex; gap:0.4rem; flex-shrink:0; align-items:center;">
          <button class="btn-pill btn-play-custom" style="font-size:0.75rem; padding:0.35rem 0.75rem;">
            ${isCurrent && this.player.isPlaying ? 'Playing' : 'Play'}
          </button>
          <button class="btn-pill btn-edit-custom" style="font-size:0.75rem; padding:0.35rem 0.65rem;" title="Edit Metadata & Artwork">Edit</button>
          <button class="btn-pill btn-delete-custom" style="font-size:0.75rem; padding:0.35rem 0.55rem; color:#ff6b6b;" title="Delete Song">&times;</button>
        </div>
      `;

      card.querySelector('.btn-play-custom').addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.loadTrack(song, true);
        if (this.trackModal) this.trackModal.classList.remove('active');
        this.renderHomePage();
      });

      card.querySelector('.btn-edit-custom').addEventListener('click', (e) => {
        e.stopPropagation();
        this.showTrackForm(song);
      });

      card.querySelector('.btn-delete-custom').addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.deleteTrack(song.id);
      });

      card.addEventListener('click', async () => {
        await this.loadTrack(song, true);
        this.trackModal.classList.remove('active');
        this.renderHomePage();
      });

      this.localTracksList.appendChild(card);
    });
  }

  populateTracksModal() {
    if (this.currentLibraryTab === 'global') {
      this.renderPublicCatalog(this.inputCatalogSearch ? this.inputCatalogSearch.value : '');
    } else {
      this.renderOfflineLibrary(this.inputCatalogSearch ? this.inputCatalogSearch.value : '');
    }
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
      if (this.audioDropzoneLabel) this.audioDropzoneLabel.textContent = 'Existing Audio Attached (Click to replace file)';

      this.selectedCoverDataUrl = trackToEdit.cover || null;
      if (this.checkSubmitToPublic) {
        this.checkSubmitToPublic.checked = !!(trackToEdit.publicAudioUrl || trackToEdit.submissionStatus === 'pending');
      }
      if (this.publicAudioUrlField) {
        this.publicAudioUrlField.style.display = (trackToEdit.publicAudioUrl || trackToEdit.submissionStatus === 'pending') ? 'block' : 'none';
      }
      if (this.inputPublicAudioUrl) {
        this.inputPublicAudioUrl.value = trackToEdit.publicAudioUrl || '';
      }
      if (this.formPublicPendingBadge) {
        this.formPublicPendingBadge.style.display = trackToEdit.submissionStatus === 'pending' ? 'inline-flex' : 'none';
      }
      this.updatePublicSubmitButtonState();
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
      if (this.checkSubmitToPublic) this.checkSubmitToPublic.checked = false;
      if (this.publicAudioUrlField) this.publicAudioUrlField.style.display = 'none';
      if (this.inputPublicAudioUrl) this.inputPublicAudioUrl.value = '';
      if (this.formPublicPendingBadge) this.formPublicPendingBadge.style.display = 'none';
      this.updatePublicSubmitButtonState();
    }
  }

  updatePublicSubmitButtonState() {
    if (!this.btnTriggerPublicSubmit) return;
    const url = this.inputPublicAudioUrl ? this.inputPublicAudioUrl.value.trim() : '';
    const hasValidUrl = url.length > 5 && (url.startsWith('http://') || url.startsWith('https://') || url.includes('.r2.dev'));
    if (hasValidUrl) {
      this.btnTriggerPublicSubmit.disabled = false;
      this.btnTriggerPublicSubmit.style.opacity = '1';
      this.btnTriggerPublicSubmit.style.cursor = 'pointer';
    } else {
      this.btnTriggerPublicSubmit.disabled = true;
      this.btnTriggerPublicSubmit.style.opacity = '0.5';
      this.btnTriggerPublicSubmit.style.cursor = 'not-allowed';
    }
  }

  openSubmissionConfirmModal() {
    this.clearFormErrors();
    const artist = this.inputCustomArtist.value.trim();
    const title = this.inputCustomTitle.value.trim();
    const audioUrl = this.inputPublicAudioUrl ? this.inputPublicAudioUrl.value.trim() : '';

    if (!artist || !title) {
      this.showFormError('Artist Name and Song Title are required before submitting to the catalog.');
      if (!artist) this.inputCustomArtist.focus();
      else if (!title) this.inputCustomTitle.focus();
      return;
    }

    if (!audioUrl) {
      this.showFormError('Public Audio URL (Cloudflare R2 link) is required for the Global Catalog.');
      if (this.inputPublicAudioUrl) this.inputPublicAudioUrl.focus();
      return;
    }

    // Populate Confirmation Modal Details
    if (this.confirmSubArtwork) {
      this.confirmSubArtwork.src = this.selectedCoverDataUrl || 
        (this.editingTrackId ? (this.tracks.find(t => t.id === this.editingTrackId)?.cover) : null) || 
        'assets/weleta_cover.jpg';
    }
    if (this.confirmSubTitle) this.confirmSubTitle.textContent = title;
    if (this.confirmSubArtist) this.confirmSubArtist.textContent = artist;
    if (this.confirmSubMeta) {
      const album = this.inputCustomAlbum.value.trim() || 'Single';
      const year = this.inputCustomYear.value.trim() || new Date().getFullYear().toString();
      this.confirmSubMeta.textContent = `${album} (${year})`;
    }
    if (this.confirmSubAudioUrl) {
      this.confirmSubAudioUrl.textContent = audioUrl;
    }
    if (this.confirmSubErrorMsg) {
      this.confirmSubErrorMsg.style.display = 'none';
      this.confirmSubErrorMsg.textContent = '';
    }

    if (this.submissionConfirmModal) {
      this.submissionConfirmModal.classList.add('active');
    }
  }

  async handleExecutePublicSubmit() {
    const artist = this.inputCustomArtist.value.trim();
    const title = this.inputCustomTitle.value.trim();
    const album = this.inputCustomAlbum.value.trim() || 'Single';
    const year = this.inputCustomYear.value.trim() || new Date().getFullYear().toString();
    const lrc = this.inputCustomLrc.value.trim() || '';
    const audioUrl = this.inputPublicAudioUrl ? this.inputPublicAudioUrl.value.trim() : '';

    const submitBtn = this.btnExecutePublicSubmit;
    const labelSpan = this.btnExecutePublicSubmitLabel;
    if (labelSpan) labelSpan.textContent = 'Submitting...';
    if (submitBtn) submitBtn.disabled = true;

    try {
      let trackObj = null;

      // 1. If currently editing existing track, update it
      if (this.editingTrackId) {
        trackObj = this.tracks.find(t => t.id === this.editingTrackId);
        if (trackObj) {
          trackObj.title = title;
          trackObj.titleEn = title;
          trackObj.artist = artist;
          trackObj.artistEn = artist;
          trackObj.album = album;
          trackObj.year = year;
          trackObj.lrc = lrc;
          trackObj.publicAudioUrl = audioUrl;
          trackObj.submissionStatus = 'pending';
          if (this.selectedCoverDataUrl) {
            trackObj.cover = this.selectedCoverDataUrl;
            trackObj.discCenter = this.selectedCoverDataUrl;
          }
          await Storage.saveTrack(trackObj);
        }
      } else {
        // 2. New track: save locally
        const coverArt = this.selectedCoverDataUrl || 'assets/weleta_cover.jpg';
        trackObj = {
          id: `track_${Date.now()}`,
          title,
          titleEn: title,
          artist,
          artistEn: artist,
          album,
          year,
          cover: coverArt,
          discCenter: coverArt,
          duration: 180,
          lrc,
          audioBlob: this.selectedAudioFile || null,
          publicAudioUrl: audioUrl,
          submissionStatus: 'pending'
        };
        await Storage.saveTrack(trackObj);
        this.editingTrackId = trackObj.id;
      }

      this.tracks = await Storage.getAllTracks();

      // 3. Send to Firebase (Direct Publish if Admin, else Submit for Review)
      if (this.isAdmin) {
        await FirebaseService.publishTrack({
          ...trackObj,
          audioUrl: audioUrl
        });
        if (trackObj) {
          trackObj.submissionStatus = 'published';
          await Storage.saveTrack(trackObj);
        }
        await this.loadPublicCatalog();
        alert(`Published "${title}" directly to the Global Public Catalog!`);
      } else {
        const coverArt = (trackObj && trackObj.cover) || this.selectedCoverDataUrl || 'assets/weleta_cover.jpg';
        await FirebaseService.submitForReview({
          title,
          artist,
          album,
          year,
          cover: coverArt,
          lrc,
          audioUrl,
          audioFileName: this.selectedAudioFile ? this.selectedAudioFile.name : `${title}.mp3`
        });
        alert(`"${title}" submitted for Public Catalog review! The admin will review it shortly.`);
      }

      // 4. Update UI state: Show pending badge in form
      if (this.formPublicPendingBadge) {
        this.formPublicPendingBadge.style.display = 'inline-flex';
      }
      if (this.submissionConfirmModal) {
        this.submissionConfirmModal.classList.remove('active');
      }

      this.renderHomePage();
      this.populateTracksModal();

    } catch (err) {
      console.error('Submission error:', err);
      if (this.confirmSubErrorMsg) {
        this.confirmSubErrorMsg.textContent = 'Submission failed: ' + (err.message || 'Network error');
        this.confirmSubErrorMsg.style.display = 'block';
      } else {
        alert('Submission failed: ' + (err.message || 'Please check your connection'));
      }
    } finally {
      if (labelSpan) labelSpan.textContent = 'Confirm & Submit';
      if (submitBtn) submitBtn.disabled = false;
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

  async applyCustomTrack() {
    this.clearFormErrors();

    const artist = this.inputCustomArtist.value.trim();
    const title = this.inputCustomTitle.value.trim();
    const album = this.inputCustomAlbum.value.trim() || 'Single';
    const year = this.inputCustomYear.value.trim() || new Date().getFullYear().toString();
    const lrc = this.inputCustomLrc.value.trim() || '';
    const submitToPublic = this.checkSubmitToPublic ? this.checkSubmitToPublic.checked : false;
    const publicAudioUrl = this.inputPublicAudioUrl ? this.inputPublicAudioUrl.value.trim() : '';

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

        if (submitToPublic && publicAudioUrl) {
          existingTrack.publicAudioUrl = publicAudioUrl;
          if (existingTrack.submissionStatus !== 'published') {
            existingTrack.submissionStatus = 'pending';
            try {
              if (this.isAdmin) {
                await FirebaseService.publishTrack({
                  ...existingTrack,
                  audioUrl: publicAudioUrl
                });
                existingTrack.submissionStatus = 'published';
                await this.loadPublicCatalog();
                alert(`Published "${title}" directly to the Global Public Catalog!`);
              } else {
                await FirebaseService.submitForReview({
                  title,
                  artist,
                  album,
                  year,
                  cover: existingTrack.cover,
                  lrc,
                  audioUrl: publicAudioUrl,
                  audioFileName: this.selectedAudioFile ? this.selectedAudioFile.name : `${title}.mp3`
                });
                alert(`"${title}" submitted for Public Catalog review! The admin will review it shortly.`);
              }
            } catch (err) {
              console.warn('Submission error during save changes:', err);
            }
          }
        }

        await Storage.saveTrack(existingTrack);
        this.tracks = await Storage.getAllTracks();

        if (this.currentTrack && this.currentTrack.id === existingTrack.id) {
          await this.loadTrack(existingTrack, this.player.isPlaying);
        }

        this.showTrackList();
        this.renderHomePage();
        return;
      }
    }

    // New Track Creation Mode
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
      audioBlob: this.selectedAudioFile,
      publicAudioUrl: publicAudioUrl || '',
      submissionStatus: submitToPublic ? 'pending' : null
    };

    await Storage.saveTrack(newTrack);
    this.tracks = await Storage.getAllTracks();

    // Community Submission or Direct Admin Publishing
    if (submitToPublic && publicAudioUrl) {
      if (this.isAdmin) {
        try {
          await FirebaseService.publishTrack({
            ...newTrack,
            audioUrl: publicAudioUrl
          });
          newTrack.submissionStatus = 'published';
          await Storage.saveTrack(newTrack);
          await this.loadPublicCatalog();
          alert(`Published "${title}" directly to the Global Public Catalog!`);
        } catch (pubErr) {
          console.warn('Direct admin publish error:', pubErr);
        }
      } else {
        try {
          await FirebaseService.submitForReview({
            title,
            artist,
            album,
            year,
            cover: coverArt,
            lrc,
            audioUrl: publicAudioUrl,
            audioFileName: this.selectedAudioFile.name
          });
          alert(`"${title}" was saved locally and submitted for Public Catalog review! Once approved by the admin, it will be published for everyone.`);
        } catch (subErr) {
          console.warn('Submission queue error:', subErr);
          alert('Saved locally! Note: Submission to public queue requires an active internet connection.');
        }
      }
    }

    // Reset inputs
    this.inputCustomArtist.value = '';
    this.inputCustomTitle.value = '';
    this.inputCustomAlbum.value = '';
    this.inputCustomYear.value = '';
    this.inputCustomLrc.value = '';
    this.selectedAudioFile = null;
    this.selectedCoverDataUrl = null;
    if (this.checkSubmitToPublic) this.checkSubmitToPublic.checked = false;

    // Load and play
    await this.loadTrack(newTrack, true);
    this.trackModal.classList.remove('active');
    this.renderHomePage();
  }

  initPullToRefresh() {
    const indicator = document.getElementById('pullToRefreshIndicator');
    if (!indicator) return;

    const ptrText = indicator.querySelector('.ptr-text');
    const ptrSpinner = indicator.querySelector('.ptr-spinner');

    let startY = 0;
    let isPulling = false;
    let isRefreshing = false;
    const threshold = 65;

    const getScrollTop = () => {
      const activeTab = document.querySelector('.tab-view.active') || document.querySelector('.tab-view[style*="display: flex"]');
      const tabScroll = activeTab ? activeTab.scrollTop : 0;
      return Math.max(window.scrollY, tabScroll, document.documentElement.scrollTop, document.body.scrollTop);
    };

    window.addEventListener('touchstart', (e) => {
      if (isRefreshing) return;
      if (getScrollTop() <= 5 && e.touches && e.touches[0]) {
        startY = e.touches[0].clientY;
        isPulling = true;
      } else {
        isPulling = false;
      }
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (!isPulling || isRefreshing || !e.touches || !e.touches[0]) return;
      const currentY = e.touches[0].clientY;
      const deltaY = currentY - startY;

      if (deltaY > 0 && getScrollTop() <= 5) {
        const pullDistance = Math.min(85, deltaY * 0.45);
        indicator.style.transform = `translateX(-50%) translateY(${pullDistance - 65}px)`;
        indicator.style.opacity = Math.min(1, pullDistance / 40);

        if (pullDistance >= threshold) {
          if (ptrText) ptrText.textContent = 'Release to refresh';
          if (ptrSpinner) ptrSpinner.style.transform = 'rotate(180deg)';
        } else {
          if (ptrText) ptrText.textContent = 'Pull to refresh';
          if (ptrSpinner) ptrSpinner.style.transform = `rotate(${(pullDistance / threshold) * 180}deg)`;
        }
      } else {
        indicator.style.opacity = '0';
        indicator.style.transform = 'translateX(-50%) translateY(-65px)';
      }
    }, { passive: true });

    window.addEventListener('touchend', async (e) => {
      if (!isPulling || isRefreshing) return;
      isPulling = false;
      const touchEndY = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientY : 0;
      const deltaY = touchEndY - startY;
      const pullDistance = Math.min(85, deltaY * 0.45);

      if (pullDistance >= threshold) {
        isRefreshing = true;
        indicator.style.transform = 'translateX(-50%) translateY(15px)';
        indicator.style.opacity = '1';
        if (ptrText) ptrText.textContent = 'Refreshing...';
        if (ptrSpinner) ptrSpinner.classList.add('spinning');

        try {
          await this.refreshContent();
          if (ptrText) ptrText.textContent = 'Updated!';
        } catch (err) {
          console.warn('Refresh error:', err);
          if (ptrText) ptrText.textContent = 'Refreshed';
        }

        setTimeout(() => {
          indicator.style.transform = 'translateX(-50%) translateY(-65px)';
          indicator.style.opacity = '0';
          if (ptrSpinner) {
            ptrSpinner.classList.remove('spinning');
            ptrSpinner.style.transform = 'rotate(0deg)';
          }
          if (ptrText) ptrText.textContent = 'Pull to refresh';
          isRefreshing = false;
        }, 500);
      } else {
        indicator.style.transform = 'translateX(-50%) translateY(-65px)';
        indicator.style.opacity = '0';
      }
    });
  }

  async refreshContent() {
    await this.loadPublicCatalog();
    if (this.isAdmin) {
      await this.checkPendingSubmissionsCount();
    }
    if (this.currentView === 'home') {
      this.renderHomePage();
    } else if (this.currentView === 'library') {
      this.renderLibraryView();
    } else if (this.currentView === 'settings') {
      this.renderSettingsView();
    }
  }

  async deleteTrack(trackId) {
    await Storage.deleteTrack(trackId);
    this.tracks = await Storage.getAllTracks();
    this.populateTracksModal();
    this.renderHomePage();

    if (this.currentTrack && this.currentTrack.id === trackId) {
      const allAvailable = [...this.publicTracks, ...this.tracks];
      if (allAvailable.length > 0) {
        await this.loadTrack(allAvailable[0], false);
      } else {
        this.renderEmptyLibraryState();
      }
    }
  }

  // --------------------------------------------------------------------------
  // Admin Studio Moderation
  // --------------------------------------------------------------------------
  async loadAdminSubmissions() {
    if (!this.adminSubmissionsList) return;
    this.adminSubmissionsList.innerHTML = `
      <div style="text-align:center; padding:1.5rem; color:var(--color-text-dim);">
        <div style="display:flex; justify-content:center; margin-bottom:0.4rem;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="ptr-spinner spinning" style="color:var(--color-gold);"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>
        </div>
        <div style="font-size:0.82rem;">Loading pending submissions...</div>
      </div>
    `;

    try {
      const list = await FirebaseService.getSubmissions();
      this.adminSubmissionsList.innerHTML = '';

      if (this.adminPendingBadge) {
        this.adminPendingBadge.textContent = list.length;
        this.adminPendingBadge.style.display = list.length > 0 ? 'inline-flex' : 'none';
      }
      if (this.adminSubmissionsBadge) {
        this.adminSubmissionsBadge.textContent = list.length;
        this.adminSubmissionsBadge.style.display = list.length > 0 ? 'inline-flex' : 'none';
      }

      if (list.length === 0) {
        this.adminSubmissionsList.innerHTML = `
          <div style="text-align:center; padding:2.5rem; color:var(--color-text-dim); font-size:0.88rem;">
            All caught up! There are currently no pending submissions in the queue.
          </div>
        `;
        return;
      }

      list.forEach(sub => {
        const item = document.createElement('div');
        item.className = 'admin-submission-item';
        item.innerHTML = `
          <div class="submission-meta-row">
            <img src="${sub.cover || 'assets/weleta_cover.jpg'}" class="submission-thumb" alt="${sub.title}" crossorigin="anonymous">
            <div style="flex:1; min-width:0;">
              <div style="font-weight:700; font-size:0.95rem; color:#fff;">${sub.title} - ${sub.artist}</div>
              <div style="font-size:0.75rem; color:var(--color-text-dim);">
                Album: ${sub.album || 'Single'} (${sub.year || '2024'}) • By: <b style="color:#fce7b2;">${sub.submittedByEmail || 'Visitor'}</b>
              </div>
              <div style="font-size:0.72rem; color:var(--color-accent); margin-top:2px;">
                ${sub.lrc ? 'Has Timed Lyrics' : 'No Lyrics'} • Audio: ${sub.audioUrl ? 'Direct Link' : (sub.audioFileName || 'Local File')}
              </div>
            </div>
          </div>

          <div style="display:flex; flex-direction:column; gap:0.4rem;">
            <label style="font-size:0.75rem; color:var(--color-gold);">Cloudflare R2 Audio URL:</label>
            <input type="text" class="form-input r2-url-input" value="${sub.audioUrl || `${R2_PUBLIC_BASE}/`}" style="font-size:0.8rem; padding:0.4rem 0.6rem;">
          </div>

          <div class="submission-actions-row">
            <div style="display:flex; gap:0.4rem;">
              <button class="btn-pill btn-sub-preview-audio" style="font-size:0.75rem; padding:0.3rem 0.65rem;">
                Play Preview
              </button>
              <button class="btn-pill btn-sub-preview-lyrics" style="font-size:0.75rem; padding:0.3rem 0.65rem;">
                View Lyrics
              </button>
            </div>
            <div style="display:flex; gap:0.4rem;">
              <button class="btn-pill btn-approve-submission" data-id="${sub.id}">
                Approve &amp; Publish
              </button>
              <button class="btn-pill btn-reject-submission" data-id="${sub.id}">
                Reject
              </button>
            </div>
          </div>
        `;

        item.querySelector('.btn-sub-preview-audio').addEventListener('click', () => {
          const url = item.querySelector('.r2-url-input').value.trim();
          this.player.loadTrack({ ...sub, audioUrl: url });
          this.player.play();
        });

        item.querySelector('.btn-sub-preview-lyrics').addEventListener('click', () => {
          alert(sub.lrc ? sub.lrc : 'No synchronized LRC lyrics attached to this submission.');
        });

        item.querySelector('.btn-approve-submission').addEventListener('click', async () => {
          const customUrl = item.querySelector('.r2-url-input').value.trim();
          try {
            await FirebaseService.approveSubmission(sub, customUrl);
            item.remove();
            await this.loadPublicCatalog();
            this.checkPendingSubmissionsCount();
            this.renderHomePage();
            alert(`Approved "${sub.title}" and published to Global Cloud Catalog!`);
          } catch (err) {
            alert('Approve error: ' + err.message);
          }
        });

        item.querySelector('.btn-reject-submission').addEventListener('click', async () => {
          if (confirm(`Reject and delete submission for "${sub.title}"?`)) {
            await FirebaseService.rejectSubmission(sub.id);
            item.remove();
            this.checkPendingSubmissionsCount();
          }
        });

        this.adminSubmissionsList.appendChild(item);
      });
    } catch (e) {
      console.warn('Submissions load error:', e);
      this.adminSubmissionsList.innerHTML = `<div style="color:#fca5a5; padding:1rem; text-align:center;">Failed to load submissions: ${e.message}</div>`;
    }
  }

  async handleAdminDirectPublish() {
    const artist = this.adminNewArtist.value.trim();
    const title = this.adminNewTitle.value.trim();
    const audioUrl = this.adminNewAudioUrl.value.trim();
    const album = this.adminNewAlbum.value.trim() || 'Single';
    const year = this.adminNewYear.value.trim() || '2024';
    const coverUrl = this.adminNewCoverUrl.value.trim() || 'assets/weleta_cover.jpg';
    const lrc = this.adminNewLrc.value.trim() || '';

    if (!artist || !title) {
      alert('Artist Name and Song Title are required.');
      return;
    }
    if (!audioUrl) {
      alert('Audio URL (Cloudflare R2 link) is required for global catalog.');
      return;
    }

    try {
      this.btnAdminPublishDirect.textContent = 'Publishing...';
      const published = await FirebaseService.publishTrack({
        artist,
        artistEn: artist,
        title,
        titleEn: title,
        album,
        year,
        audioUrl,
        cover: coverUrl,
        discCenter: coverUrl,
        lrc
      });

      this.btnAdminPublishDirect.textContent = 'Publish Directly to Global Catalog';
      if (this.adminModal) this.adminModal.classList.remove('active');
      await this.loadPublicCatalog();
      this.renderHomePage();
      await this.loadTrack(published, true);
      alert(`Published "${title}" directly to the Global Catalog!`);

      this.adminNewArtist.value = '';
      this.adminNewTitle.value = '';
      this.adminNewAlbum.value = '';
      this.adminNewAudioUrl.value = '';
      this.adminNewCoverUrl.value = '';
      this.adminNewLrc.value = '';
    } catch (err) {
      this.btnAdminPublishDirect.textContent = 'Publish Directly to Global Catalog';
      alert('Publishing error: ' + err.message);
    }
  }

  initThemeSystem() {
    if (!this.themeOptionsList) return;
    this.themeOptionsList.innerHTML = '';

    const curTheme = THEMES.find(t => t.id === this.themeManager.currentTheme);
    const badgeLabel = document.getElementById('activeThemeBadgeLabel');
    if (badgeLabel && curTheme) {
      badgeLabel.textContent = curTheme.name;
    }

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
        if (badgeLabel) badgeLabel.textContent = t.name;
        if (this.themeModal) this.themeModal.classList.remove('active');
        requestAnimationFrame(() => {
          if (this.currentView === 'stage' || this.currentView === 'lyrics') {
            this.syncLyrics(this.player.currentTime);
          }
        });
      });
      this.themeOptionsList.appendChild(card);
    });
  }
}

// Instantiate on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.lyricsApp = new LyricsApp();
});
