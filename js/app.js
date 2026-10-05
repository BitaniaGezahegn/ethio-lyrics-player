import { LyricsParser } from './lyrics-parser.js';
import { AudioPlayer } from './player.js';
import { ThemeManager, THEMES } from './theme-manager.js';
import { LrcEditor } from './lrc-editor.js';
import { Storage } from './storage.js';
import { PaletteExtractor } from './palette.js';
import { AmbientParticles } from './particles.js';
import { FirebaseService, ADMIN_EMAIL, R2_PUBLIC_BASE } from './firebase-service.js';
import { GuestSyncEngine, HostBroadcaster, SYNC_CONFIG } from './party-sync.js';
import { RecommendationEngine } from './recommendation-engine.js';

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

    // Cloud Sync State
    this.favorites = Storage.getFavorites();
    this.recentlyPlayed = Storage.getRecentlyPlayed();
    this.userSyncUnsubscribe = null;
    this.isSyncing = false;
    this._cloudSyncTimer = null;

    // Playlists & Playback Control State
    this.playlists = Storage.getPlaylists();
    this.activePlaylist = null;
    this.queue = [];
    this.queueIndex = -1;
    this.shuffleMode = Storage.getShuffleState();
    this.repeatMode = Storage.getRepeatState(); // 'off' | 'all' | 'one'
    this.sleepTimerTargetMs = null;
    this.sleepTimerInterval = null;
    this.currentPendingPlaylistTrack = null;

    // Listen Together (Party Room & Synced Playback v2) State
    this.activeRoom = null;
    this.isRoomHost = false;
    this.roomUnsubscribe = null;
    this.roomParticipantsUnsubscribe = null;
    this.roomReactionsUnsubscribe = null;
    this.myParticipant = Storage.getParticipant(null);
    this._isApplyingRemoteSync = false;
    this._seenReactionIds = new Set();
    this.guestSync = null;
    this.hostBroadcaster = null;
    this.presenceHeartbeatTimer = null;
    this.presenceParticipants = [];
    this.audioDelaySec = Storage.getAudioDelayMs() / 1000;
    this.debugSparklineHistory = [];
    this.debugTimer = null;

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
    this.initDebugOverlay();
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
      this.setQueue(allAvailable, allAvailable.indexOf(initialTrack));
      await this.loadTrack(initialTrack, false); // load metadata without autoplaying
    } else {
      this.renderEmptyLibraryState();
    }

    // Initialize playback mode UI
    this.initPlaybackModeUI();

    // 4. Render Home Music Suggestion & Discovery View
    this.renderHomePage();

    // 5. Check if user opened via Room Invite link (?room=ETHIO-XXXX or #room=ETHIO-XXXX)
    try {
      const urlParams = new URLSearchParams(window.location.search);
      let roomCode = urlParams.get('room');
      if (!roomCode && window.location.hash.includes('room=')) {
        roomCode = window.location.hash.split('room=')[1];
      }
      if (roomCode) {
        const cleanCode = roomCode.trim().toUpperCase();
        const suffix = cleanCode.replace(/^ETHIO-?/i, '').replace(/[^A-Z0-9]/g, '').slice(0, 4);
        if (this.inputJoinRoomCode) this.inputJoinRoomCode.value = suffix;
        this.openListenTogetherModal();
        setTimeout(() => {
          this.handleJoinRoom(cleanCode);
        }, 800);
      }
    } catch (e) {
      console.warn('URL room check error:', e);
    }
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
    this.btnManualSyncNow = document.getElementById('btnManualSyncNow');
    this.syncStatusBadge = document.getElementById('syncStatusBadge');
    this.lastSyncedTimeLabel = document.getElementById('lastSyncedTimeLabel');
    this.syncNowIcon = document.getElementById('syncNowIcon');

    // Listen Together Elements
    this.btnOpenListenTogether = document.getElementById('btnOpenListenTogether');
    this.listenTogetherBtnText = document.getElementById('listenTogetherBtnText');
    this.liveRoomActiveIndicator = document.getElementById('liveRoomActiveIndicator');
    this.listenTogetherModal = document.getElementById('listenTogetherModal');
    this.roomLobbyView = document.getElementById('roomLobbyView');
    this.roomActiveView = document.getElementById('roomActiveView');
    this.btnCreateRoom = document.getElementById('btnCreateRoom');
    this.inputJoinRoomCode = document.getElementById('inputJoinRoomCode');
    this.btnJoinRoom = document.getElementById('btnJoinRoom');
    this.joinRoomError = document.getElementById('joinRoomError');
    this.currentParticipantNameLabel = document.getElementById('currentParticipantNameLabel');
    this.btnEditParticipantName = document.getElementById('btnEditParticipantName');
    this.activeRoomCodeTitle = document.getElementById('activeRoomCodeTitle');
    this.activeRoomRoleText = document.getElementById('activeRoomRoleText');
    this.btnShareInviteLinkModal = document.getElementById('btnShareInviteLinkModal') || document.getElementById('btnCopyInviteLinkModal');
    this.shareInviteLinkModalLabel = document.getElementById('shareInviteLinkModalLabel') || document.getElementById('copyInviteLinkModalLabel');
    this.btnCopyInviteLinkModal = this.btnShareInviteLinkModal;
    this.copyInviteLinkModalLabel = this.shareInviteLinkModalLabel;
    this.activeRoomTrackArt = document.getElementById('activeRoomTrackArt');
    this.activeRoomTrackTitle = document.getElementById('activeRoomTrackTitle');
    this.activeRoomTrackArtist = document.getElementById('activeRoomTrackArtist');
    this.activeRoomTrackStateBadge = document.getElementById('activeRoomTrackStateBadge');
    this.activeRoomCountBadge = document.getElementById('activeRoomCountBadge');
    this.activeRoomParticipantsList = document.getElementById('activeRoomParticipantsList');
    this.btnLeaveRoomModal = document.getElementById('btnLeaveRoomModal');
    this.activeListenRoomBar = document.getElementById('activeListenRoomBar');
    this.roomBarCodeLabel = document.getElementById('roomBarCodeLabel');
    this.roomBarRolePill = document.getElementById('roomBarRolePill');
    this.roomBarListenersLabel = document.getElementById('roomBarListenersLabel');
    this.btnShareRoomLink = document.getElementById('btnShareRoomLink') || document.getElementById('btnCopyRoomLink');
    this.shareLinkBtnText = document.getElementById('shareLinkBtnText') || document.getElementById('copyLinkBtnText');
    this.btnCopyRoomLink = this.btnShareRoomLink;
    this.copyLinkBtnText = this.shareLinkBtnText;
    this.btnManageActiveRoom = document.getElementById('btnManageActiveRoom');
    this.btnLeaveRoom = document.getElementById('btnLeaveRoom');
    this.btnToggleReactions = document.getElementById('btnToggleReactions');
    this.reactionsDropdown = document.getElementById('reactionsDropdown');
    this.reactionFloatingStage = document.getElementById('reactionFloatingStage');

    // Listen Together v2 Sync & Delay Controls
    this.roomBarSyncChip = document.getElementById('roomBarSyncChip');
    this.roomBarSyncChipText = document.getElementById('roomBarSyncChipText');
    this.btnModalResync = document.getElementById('btnModalResync');
    this.sliderAudioDelay = document.getElementById('sliderAudioDelay');
    this.audioDelayValueLabel = document.getElementById('audioDelayValueLabel');
    this.partySyncDebugOverlay = document.getElementById('partySyncDebugOverlay');
    this.btnDebugClose = document.getElementById('btnDebugClose');
    this.dbgClockOffset = document.getElementById('dbgClockOffset');
    this.dbgBestRtt = document.getElementById('dbgBestRtt');
    this.dbgStatus = document.getElementById('dbgStatus');
    this.dbgDrift = document.getElementById('dbgDrift');
    this.dbgMedian = document.getElementById('dbgMedian');
    this.dbgRate = document.getElementById('dbgRate');
    this.dbgEpochAction = document.getElementById('dbgEpochAction');
    this.dbgSeekStats = document.getElementById('dbgSeekStats');
    this.dbgSparkline = document.getElementById('dbgSparkline');

    // Hero Spotlight Section
    this.heroCard = document.getElementById('heroCard');
    this.heroArtworkImg = document.getElementById('heroArtworkImg');
    this.btnHeroPlayBadge = document.getElementById('btnHeroPlayBadge');
    this.heroTitle = document.getElementById('heroTitle');
    this.heroArtist = document.getElementById('heroArtist');
    this.heroPlayLabel = document.getElementById('heroPlayLabel');
    this.btnHeroPlay = document.getElementById('btnHeroPlay');
    this.btnHeroOpenLyrics = document.getElementById('btnHeroOpenLyrics');
    this.btnHeroDetails = document.getElementById('btnHeroDetails');
    this.btnHeroFavorite = document.getElementById('btnHeroFavorite');

    // Home Discovery Grids, Shelves & Filters
    this.greetingMoodBadge = document.getElementById('greetingMoodBadge');
    this.greetingMoodText = document.getElementById('greetingMoodText');
    this.greetingHeadingText = document.getElementById('greetingHeadingText');
    this.greetingHeadingAmharic = document.getElementById('greetingHeadingAmharic');
    this.greetingSubtext = document.getElementById('greetingSubtext');
    this.dnaStatTotal = document.getElementById('dnaStatTotal');
    this.dnaStatLrc = document.getElementById('dnaStatLrc');
    this.dnaStatFavs = document.getElementById('dnaStatFavs');
    this.heroDurationBadge = document.getElementById('heroDurationBadge');
    this.heroLrcBadge = document.getElementById('heroLrcBadge');

    this.homeFilterRow = document.getElementById('homeFilterRow');
    this.inputHomeSearch = document.getElementById('inputHomeSearch');
    this.btnClearHomeSearch = document.getElementById('btnClearHomeSearch');
    this.sectionJumpBackIn = document.getElementById('sectionJumpBackIn');
    this.gridJumpBackIn = document.getElementById('gridJumpBackIn');
    this.sectionRecommendations = document.getElementById('sectionRecommendations');
    this.gridSuggestions = document.getElementById('gridSuggestions');
    this.btnShuffleRecommended = document.getElementById('btnShuffleRecommended');
    this.sectionBecauseYouListened = document.getElementById('sectionBecauseYouListened');
    this.becauseTitleText = document.getElementById('becauseTitleText');
    this.becauseSubtitleText = document.getElementById('becauseSubtitleText');
    this.gridBecauseYouListened = document.getElementById('gridBecauseYouListened');
    this.btnPlayBecauseShelf = document.getElementById('btnPlayBecauseShelf');
    this.sectionLyricsShowcase = document.getElementById('sectionLyricsShowcase');
    this.gridLyricsShowcase = document.getElementById('gridLyricsShowcase');
    this.btnPlayLyricsShowcase = document.getElementById('btnPlayLyricsShowcase');
    this.sectionIconicArtists = document.getElementById('sectionIconicArtists');
    this.rowIconicArtists = document.getElementById('rowIconicArtists');
    this.sectionGlobalCatalog = document.getElementById('sectionGlobalCatalog');
    this.gridGlobalCatalog = document.getElementById('gridGlobalCatalog');
    this.gridPersonalCatalog = document.getElementById('gridPersonalCatalog');
    this.selectCatalogSort = document.getElementById('selectCatalogSort');
    this.catalogCounterSubtitle = document.getElementById('catalogCounterSubtitle');
    this.catalogSortOption = 'newest';

    // Lyrics Stage & Header Elements
    this.artistAmharic = document.getElementById('artistAmharic');
    this.artistEnglish = document.getElementById('artistEnglish');
    this.songTitleAmharic = document.getElementById('songTitleAmharic');
    this.btnLyricsFavorite = document.getElementById('btnLyricsFavorite');
    this.lyricsFavText = document.getElementById('lyricsFavText');
    this.albumTitle = document.getElementById('albumTitle');
    this.albumYear = document.getElementById('albumYear');
    this.discArtwork = document.getElementById('discArtwork');
    this.vinylDisc = document.getElementById('vinylDisc');

    // Mini Player Info
    this.playerMiniArt = document.getElementById('playerMiniArt');
    this.playerMiniTitle = document.getElementById('playerMiniTitle');
    this.playerMiniArtist = document.getElementById('playerMiniArtist');
    this.btnDockFavorite = document.getElementById('btnDockFavorite');

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
    this.volumeContainer = document.getElementById('volumeContainer');
    this.volumePopupTray = document.getElementById('volumePopupTray');
    this.volumeSlider = document.getElementById('volumeSlider');
    this.volumePercentBadge = document.getElementById('volumePercentBadge');
    this.volumeIconHigh = document.getElementById('volumeIconHigh');
    this.volumeIconMuted = document.getElementById('volumeIconMuted');
    this.scrubberTrack = document.getElementById('scrubberTrack');
    this.scrubberFill = document.getElementById('scrubberFill');
    this.currentTimeLabel = document.getElementById('currentTimeLabel');
    this.durationLabel = document.getElementById('durationLabel');
    this.btnToggleFullscreen = document.getElementById('btnToggleFullscreen');

    // Modern Playback Controls: Shuffle, Prev, Next, Repeat, Sleep, Queue, Add-to-Playlist
    this.btnShuffle = document.getElementById('btnShuffle');
    this.btnPrevTrack = document.getElementById('btnPrevTrack');
    this.btnNextTrack = document.getElementById('btnNextTrack');
    this.btnRepeat = document.getElementById('btnRepeat');
    this.btnDockAddToPlaylist = document.getElementById('btnDockAddToPlaylist');
    this.btnSleepTimer = document.getElementById('btnSleepTimer');
    this.sleepTimerBadge = document.getElementById('sleepTimerBadge');
    this.btnQueue = document.getElementById('btnQueue');
    this.queueCountBadge = document.getElementById('queueCountBadge');

    // Playlists & Queue Elements
    this.tabPlaylists = document.getElementById('tabPlaylists');
    this.catalogSearchWrap = document.getElementById('catalogSearchWrap');
    this.playlistsContainer = document.getElementById('playlistsContainer');
    this.playlistsGrid = document.getElementById('playlistsGrid');
    this.btnOpenCreatePlaylistModal = document.getElementById('btnOpenCreatePlaylistModal');
    this.cardSmartLikedSongs = document.getElementById('cardSmartLikedSongs');
    this.cardSmartRecentSongs = document.getElementById('cardSmartRecentSongs');
    this.smartLikedSongsCount = document.getElementById('smartLikedSongsCount');
    this.smartRecentSongsCount = document.getElementById('smartRecentSongsCount');
    this.singlePlaylistView = document.getElementById('singlePlaylistView');
    this.btnBackToPlaylistsList = document.getElementById('btnBackToPlaylistsList');
    this.playlistBannerTitle = document.getElementById('playlistBannerTitle');
    this.playlistBannerDesc = document.getElementById('playlistBannerDesc');
    this.playlistBannerMeta = document.getElementById('playlistBannerMeta');
    this.playlistBannerArt = document.getElementById('playlistBannerArt');
    this.btnPlaylistPlayAll = document.getElementById('btnPlaylistPlayAll');
    this.btnPlaylistShuffle = document.getElementById('btnPlaylistShuffle');
    this.btnPlaylistAddTracks = document.getElementById('btnPlaylistAddTracks');
    this.btnPlaylistDelete = document.getElementById('btnPlaylistDelete');
    this.playlistTracksList = document.getElementById('playlistTracksList');

    // Modals
    this.createPlaylistModal = document.getElementById('createPlaylistModal');
    this.formCreatePlaylist = document.getElementById('formCreatePlaylist');
    this.inputPlaylistTitle = document.getElementById('inputPlaylistTitle');
    this.inputPlaylistDesc = document.getElementById('inputPlaylistDesc');
    this.addToPlaylistModal = document.getElementById('addToPlaylistModal');
    this.btnQuickCreatePlaylist = document.getElementById('btnQuickCreatePlaylist');
    this.addToPlaylistChoicesList = document.getElementById('addToPlaylistChoicesList');
    this.addToPlaylistCover = document.getElementById('addToPlaylistCover');
    this.addToPlaylistTitle = document.getElementById('addToPlaylistTitle');
    this.addToPlaylistArtist = document.getElementById('addToPlaylistArtist');
    this.queueDrawerModal = document.getElementById('queueDrawerModal');
    this.btnClearQueue = document.getElementById('btnClearQueue');
    this.queueNowPlayingArt = document.getElementById('queueNowPlayingArt');
    this.queueNowPlayingTitle = document.getElementById('queueNowPlayingTitle');
    this.queueNowPlayingArtist = document.getElementById('queueNowPlayingArtist');
    this.queueUpcomingList = document.getElementById('queueUpcomingList');
    this.queueUpcomingCount = document.getElementById('queueUpcomingCount');
    this.sleepTimerModal = document.getElementById('sleepTimerModal');
    this.btnTurnOffSleepTimer = document.getElementById('btnTurnOffSleepTimer');
    this.btnDetailAddToPlaylist = document.getElementById('btnDetailAddToPlaylist');
    this.addTracksToPlaylistPickerModal = document.getElementById('addTracksToPlaylistPickerModal');
    this.inputPlaylistSongSearch = document.getElementById('inputPlaylistSongSearch');
    this.playlistSongPickerList = document.getElementById('playlistSongPickerList');

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

    // Song Details Modal Elements
    this.songDetailsModal = document.getElementById('songDetailsModal');
    this.detailModalCover = document.getElementById('detailModalCover');
    this.detailModalTitle = document.getElementById('detailModalTitle');
    this.detailModalArtist = document.getElementById('detailModalArtist');
    this.detailModalArtistEn = document.getElementById('detailModalArtistEn');
    this.detailModalAlbum = document.getElementById('detailModalAlbum');
    this.detailModalLrcChip = document.getElementById('detailModalLrcChip');
    this.detailModalOfflineChip = document.getElementById('detailModalOfflineChip');
    this.detailModalLyricsSnippet = document.getElementById('detailModalLyricsSnippet');
    this.btnDetailModalPlay = document.getElementById('btnDetailModalPlay');
    this.btnDetailPlayNow = document.getElementById('btnDetailPlayNow');
    this.detailPlayNowLabel = document.getElementById('detailPlayNowLabel');
    this.btnDetailViewLyrics = document.getElementById('btnDetailViewLyrics');
    this.btnDetailToggleFavorite = document.getElementById('btnDetailToggleFavorite');
    this.detailFavLabel = document.getElementById('detailFavLabel');
    this.btnDetailSaveOffline = document.getElementById('btnDetailSaveOffline');
    this.detailSaveLabel = document.getElementById('detailSaveLabel');
    this.btnDetailOpenLyricsEditor = document.getElementById('btnDetailOpenLyricsEditor');

    // Attribution Watermark Overlay (Active in Fullscreen Record Mode)
    this.tiktokWatermark = document.getElementById('tiktokWatermark');
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
      this.initCloudSync(user.uid);
      this.myParticipant = Storage.getParticipant(user);
      if (this.currentParticipantNameLabel) {
        this.currentParticipantNameLabel.textContent = this.myParticipant.name;
      }
    } else {
      if (this.btnGoogleSignIn) this.btnGoogleSignIn.style.display = 'inline-flex';
      if (this.userProfilePill) this.userProfilePill.style.display = 'none';
      if (this.settingsAuthSignedOut) this.settingsAuthSignedOut.style.display = 'flex';
      if (this.settingsAuthSignedIn) this.settingsAuthSignedIn.style.display = 'none';
      if (this.settingsAdminRow) this.settingsAdminRow.style.display = 'none';
      if (this.userSyncUnsubscribe) {
        this.userSyncUnsubscribe();
        this.userSyncUnsubscribe = null;
      }
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

    if (this.tiktokWatermark) {
      const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || (this.appEl && this.appEl.classList.contains('is-fullscreen')));
      this.tiktokWatermark.style.display = (isFs && tabId === 'lyrics') ? 'block' : 'none';
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
    if (this.btnHeroDetails) {
      this.btnHeroDetails.addEventListener('click', () => {
        const track = this.currentTrack || (this.publicTracks.length > 0 ? this.publicTracks[0] : (this.tracks.length > 0 ? this.tracks[0] : null));
        if (track) this.openSongDetails(track);
      });
    }
    if (this.btnHeroFavorite) {
      this.btnHeroFavorite.addEventListener('click', (e) => {
        e.stopPropagation();
        const track = this.currentTrack || (this.publicTracks.length > 0 ? this.publicTracks[0] : (this.tracks.length > 0 ? this.tracks[0] : null));
        if (track) this.toggleTrackFavorite(track.id);
      });
    }
    if (this.btnDockFavorite) {
      this.btnDockFavorite.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.currentTrack) this.toggleTrackFavorite(this.currentTrack.id);
      });
    }
    if (this.btnLyricsFavorite) {
      this.btnLyricsFavorite.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.currentTrack) this.toggleTrackFavorite(this.currentTrack.id);
      });
    }
    if (this.btnManualSyncNow) {
      this.btnManualSyncNow.addEventListener('click', async () => {
        await this.triggerManualSync();
      });
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
      const spotlightTrack = this.currentTrack || (this.publicTracks.length > 0 ? this.publicTracks[0] : (this.tracks.length > 0 ? this.tracks[0] : null));
      if (!spotlightTrack) return;
      if (this.currentTrack && this.currentTrack.id === spotlightTrack.id) {
        this.player.togglePlay();
      } else {
        const pool = [...this.publicTracks, ...this.tracks];
        this.setQueue(pool, pool.findIndex(t => t.id === spotlightTrack.id));
        await this.loadTrack(spotlightTrack, true);
      }
      this.updateHeroState();
    };

    if (this.btnHeroPlay) this.btnHeroPlay.addEventListener('click', handleHeroPlay);
    if (this.btnHeroPlayBadge) this.btnHeroPlayBadge.addEventListener('click', handleHeroPlay);

    if (this.btnHeroOpenLyrics) {
      this.btnHeroOpenLyrics.addEventListener('click', () => {
        this.switchTab('lyrics');
      });
    }

    const btnHeroDetails = document.getElementById('btnHeroDetails');
    if (btnHeroDetails) {
      btnHeroDetails.addEventListener('click', () => {
        const spotlightTrack = this.currentTrack || (this.publicTracks.length > 0 ? this.publicTracks[0] : (this.tracks.length > 0 ? this.tracks[0] : null));
        if (spotlightTrack) this.openSongDetails(spotlightTrack);
      });
    }

    const btnHeroQueue = document.getElementById('btnHeroQueue');
    if (btnHeroQueue) {
      btnHeroQueue.addEventListener('click', () => {
        const spotlightTrack = this.currentTrack || (this.publicTracks.length > 0 ? this.publicTracks[0] : (this.tracks.length > 0 ? this.tracks[0] : null));
        if (spotlightTrack) this.addToQueue(spotlightTrack, false);
      });
    }

    // Filter Chips
    if (this.homeFilterRow) {
      this.homeFilterRow.addEventListener('click', (e) => {
        const chip = e.target.closest('.home-filter-chip') || e.target.closest('.filter-chip');
        if (!chip) return;
        this.homeFilterRow.querySelectorAll('.home-filter-chip, .filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.activeFilter = chip.getAttribute('data-filter') || 'all';
        this.renderHomePage();
      });
    }

    // Search Input with Clear Button
    if (this.inputHomeSearch) {
      this.inputHomeSearch.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.trim().toLowerCase();
        if (this.btnClearHomeSearch) {
          this.btnClearHomeSearch.style.display = this.searchQuery ? 'inline-flex' : 'none';
        }
        this.renderHomePage();
      });
    }

    if (this.btnClearHomeSearch) {
      this.btnClearHomeSearch.addEventListener('click', () => {
        if (this.inputHomeSearch) this.inputHomeSearch.value = '';
        this.searchQuery = '';
        this.btnClearHomeSearch.style.display = 'none';
        this.renderHomePage();
      });
    }

    // Shelf Actions: Shuffle Recommended Mix
    if (this.btnShuffleRecommended) {
      this.btnShuffleRecommended.addEventListener('click', async () => {
        const allTracks = [...this.publicTracks, ...this.tracks];
        const mix = RecommendationEngine.getPersonalizedRecommendations(allTracks, {
          favorites: this.favorites,
          recentlyPlayed: this.recentlyPlayed,
          currentTrack: this.currentTrack,
          activeVibe: this.activeFilter,
          limit: 12
        });
        if (mix.length > 0) {
          const shuffled = [...mix].sort(() => Math.random() - 0.5);
          this.setQueue(shuffled, 0);
          await this.loadTrack(shuffled[0], true);
          this.showToast('Shuffling Recommended Mix ✨');
        }
      });
    }

    // Shelf Actions: Play Because You Listened Shelf
    if (this.btnPlayBecauseShelf) {
      this.btnPlayBecauseShelf.addEventListener('click', async () => {
        const allTracks = [...this.publicTracks, ...this.tracks];
        const shelf = RecommendationEngine.getBecauseYouListenedShelf(allTracks, {
          recentlyPlayed: this.recentlyPlayed,
          favorites: this.favorites,
          currentTrack: this.currentTrack
        });
        if (shelf && shelf.tracks.length > 0) {
          this.setQueue(shelf.tracks, 0);
          await this.loadTrack(shelf.tracks[0], true);
          this.showToast(`Playing tracks inspired by ${shelf.seedArtist} 🎵`);
        }
      });
    }

    // Shelf Actions: Play Lyrics Stage Showcase Shelf
    if (this.btnPlayLyricsShowcase) {
      this.btnPlayLyricsShowcase.addEventListener('click', async () => {
        const allTracks = [...this.publicTracks, ...this.tracks];
        const showcase = RecommendationEngine.getLyricsStageShowcase(allTracks, 10);
        if (showcase.length > 0) {
          this.setQueue(showcase, 0);
          await this.loadTrack(showcase[0], true);
          this.showToast('Playing Synced Lyrics Showcase 📜');
        }
      });
    }

    // Catalog Sort Select
    if (this.selectCatalogSort) {
      this.selectCatalogSort.addEventListener('change', (e) => {
        this.catalogSortOption = e.target.value;
        this.renderHomePage();
      });
    }

    // Play / Pause
    if (this.btnPlayPause) {
      this.btnPlayPause.addEventListener('click', () => {
        if (this.isGuestLocked('playback')) return;
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
        if (this.isGuestLocked('seeking')) return;
        if (this.currentTrack) {
          const target = Math.max(0, this.player.currentTime - 5);
          this.player.seek(target);
        }
      });
    }
    if (this.btnForward) {
      this.btnForward.addEventListener('click', () => {
        if (this.isGuestLocked('seeking')) return;
        if (this.currentTrack) {
          const target = this.player.currentTime + 5;
          this.player.seek(target);
        }
      });
    }

    // Shuffle & Repeat
    if (this.btnShuffle) {
      this.btnShuffle.addEventListener('click', () => this.toggleShuffle());
    }
    if (this.btnRepeat) {
      this.btnRepeat.addEventListener('click', () => this.toggleRepeat());
    }

    // Previous & Next Track
    if (this.btnPrevTrack) {
      this.btnPrevTrack.addEventListener('click', () => {
        if (this.isGuestLocked('tracks')) return;
        this.playPrevTrack();
      });
    }
    if (this.btnNextTrack) {
      this.btnNextTrack.addEventListener('click', () => {
        if (this.isGuestLocked('tracks')) return;
        this.playNextTrack();
      });
    }

    // Add to Playlist on Dock
    if (this.btnDockAddToPlaylist) {
      this.btnDockAddToPlaylist.addEventListener('click', () => {
        this.openAddToPlaylistModal(this.currentTrack);
      });
    }

    // Sleep Timer Button
    if (this.btnSleepTimer) {
      this.btnSleepTimer.addEventListener('click', () => this.openSleepTimerModal());
    }

    // Up Next Queue Button
    if (this.btnQueue) {
      this.btnQueue.addEventListener('click', () => this.openQueueDrawer());
    }
    if (this.btnClearQueue) {
      this.btnClearQueue.addEventListener('click', () => this.clearQueue());
    }

    // Sleep timer option clicks
    document.querySelectorAll('.btn-timer-option[data-timer]').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-timer');
        if (val === 'end_of_track') {
          this.setSleepTimer('end_of_track');
        } else {
          this.setSleepTimer(parseInt(val, 10));
        }
        if (this.sleepTimerModal) this.sleepTimerModal.classList.remove('active');
      });
    });
    if (this.btnTurnOffSleepTimer) {
      this.btnTurnOffSleepTimer.addEventListener('click', () => {
        this.clearSleepTimer();
        if (this.sleepTimerModal) this.sleepTimerModal.classList.remove('active');
      });
    }

    // Song Details Add to Playlist Button
    if (this.btnDetailAddToPlaylist) {
      this.btnDetailAddToPlaylist.addEventListener('click', () => {
        this.openAddToPlaylistModal(this._detailModalActiveTrack || this.currentTrack);
      });
    }

    // Playlist Creation Form
    if (this.btnOpenCreatePlaylistModal) {
      this.btnOpenCreatePlaylistModal.addEventListener('click', () => this.openCreatePlaylistModal());
    }
    if (this.btnQuickCreatePlaylist) {
      this.btnQuickCreatePlaylist.addEventListener('click', () => {
        if (this.addToPlaylistModal) this.addToPlaylistModal.classList.remove('active');
        this.openCreatePlaylistModal();
      });
    }
    if (this.formCreatePlaylist) {
      this.formCreatePlaylist.addEventListener('submit', (e) => this.handleCreatePlaylist(e));
    }

    // Smart Playlists
    if (this.cardSmartLikedSongs) {
      this.cardSmartLikedSongs.addEventListener('click', () => this.openSmartPlaylist('liked'));
    }
    if (this.cardSmartRecentSongs) {
      this.cardSmartRecentSongs.addEventListener('click', () => this.openSmartPlaylist('recent'));
    }

    // Single Playlist View Actions
    if (this.btnBackToPlaylistsList) {
      this.btnBackToPlaylistsList.addEventListener('click', () => {
        if (this.singlePlaylistView) this.singlePlaylistView.style.display = 'none';
        if (this.playlistsContainer) this.playlistsContainer.style.display = 'flex';
      });
    }
    if (this.btnPlaylistPlayAll) {
      this.btnPlaylistPlayAll.addEventListener('click', () => this.playCurrentPlaylist(false));
    }
    if (this.btnPlaylistShuffle) {
      this.btnPlaylistShuffle.addEventListener('click', () => this.playCurrentPlaylist(true));
    }
    if (this.btnPlaylistAddTracks) {
      this.btnPlaylistAddTracks.addEventListener('click', () => this.openAddTracksToPlaylistPicker());
    }
    if (this.btnPlaylistDelete) {
      this.btnPlaylistDelete.addEventListener('click', () => this.deleteCurrentPlaylist());
    }

    // Search filter in Playlist Track Picker
    if (this.inputPlaylistSongSearch) {
      this.inputPlaylistSongSearch.addEventListener('input', (e) => {
        this.renderAddTracksPickerList(e.target.value.trim().toLowerCase());
      });
    }

    // Playback Speed Toggle
    if (this.btnSpeed) {
      const speeds = [1.0, 1.25, 1.5, 0.75];
      let speedIdx = 0;
      this.btnSpeed.addEventListener('click', () => {
        if (this.isGuestLocked('playback speed')) return;
        speedIdx = (speedIdx + 1) % speeds.length;
        const spd = speeds[speedIdx];
        this.player.setPlaybackRate(spd);
        this.btnSpeed.textContent = `${spd}x`;
        if (this.activeRoom && this.isRoomHost) {
          this.hostBroadcaster?.notify('rate');
        }
      });
    }

    // Audio Player State Listeners
    this.player.onPlaying = () => {
      if (this.activeRoom && this.isRoomHost && !this._isApplyingRemoteSync) {
        this.hostBroadcaster?.notify('play');
      }
      if (this.guestSync) {
        this.guestSync.notifyPlaying();
      }
    };

    this.player.onSeeked = () => {
      if (this.activeRoom && this.isRoomHost && !this._isApplyingRemoteSync) {
        this.hostBroadcaster?.notify('seek');
      }
    };

    this.player.onWaiting = () => {
      if (this.guestSync) {
        this.guestSync.notifyWaiting();
      }
    };

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

      if (state === 'paused' && this.activeRoom && this.isRoomHost && !this._isApplyingRemoteSync) {
        this.hostBroadcaster?.notify('pause');
      }
    };

    this.player.onTimeUpdate = (currentTime, duration) => {
      if (!this.isScrubbing) {
        this.updateTimeline(currentTime, duration);
      }
      if (this.currentView === 'stage' || this.currentView === 'lyrics') {
        this.syncLyrics(currentTime);
      }
    };

    this.player.onDurationChange = (duration) => {
      if (this.currentTrack && duration > 0) {
        this.currentTrack.duration = Math.round(duration);
        Storage.updateTrackDuration(this.currentTrack.id, this.currentTrack.duration);
      }
      if (!this.isScrubbing) {
        this.updateTimeline(this.player.currentTime, duration);
      }
    };

    // Smart Queue: When a song ends, respect repeat mode & play next
    this.player.onEnded = async () => {
      if (this.playIcon) this.playIcon.style.display = 'block';
      if (this.pauseIcon) this.pauseIcon.style.display = 'none';
      if (this.vinylDisc) this.vinylDisc.classList.remove('spinning');
      this.syncLyrics(0);

      // In party mode, guests must wait for the host's anchor and not auto-advance
      if (this.activeRoom && !this.isRoomHost) {
        return;
      }

      // Check Sleep Timer "End of Track"
      if (this.sleepTimerTargetMs === 'end_of_track') {
        this.clearSleepTimer();
        this.showToast('Sleep timer finished. Playback paused 🌙');
        return;
      }

      await this.playNextTrack();
    };

    // Volume & Mute (Desktop and Mobile Touch Support)
    let lastVolume = 0.8;
    const updateVolumeUI = (val) => {
      const clamped = Math.max(0, Math.min(1, val));
      if (this.volumeSlider) this.volumeSlider.value = clamped;
      if (this.volumePercentBadge) this.volumePercentBadge.textContent = `${Math.round(clamped * 100)}%`;
      if (this.volumeIconHigh && this.volumeIconMuted) {
        if (clamped <= 0.01) {
          this.volumeIconHigh.style.display = 'none';
          this.volumeIconMuted.style.display = 'block';
        } else {
          this.volumeIconHigh.style.display = 'block';
          this.volumeIconMuted.style.display = 'none';
        }
      }
    };

    if (this.volumeSlider) {
      this.volumeSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.player.setVolume(val);
        if (val > 0.02) lastVolume = val;
        updateVolumeUI(val);
      });
    }

    if (this.btnMute) {
      this.btnMute.addEventListener('click', (e) => {
        e.stopPropagation();
        // On touch screens or small devices, tap opens/toggles the slider tray
        if (this.volumeContainer && window.innerWidth <= 768) {
          const wasOpen = this.volumeContainer.classList.contains('tray-active');
          if (!wasOpen) {
            this.volumeContainer.classList.add('tray-active');
            return;
          }
        }

        // Toggle mute or restore volume
        if (this.player.volume > 0.01) {
          lastVolume = this.player.volume || 0.8;
          this.player.setVolume(0);
          updateVolumeUI(0);
        } else {
          const restored = lastVolume > 0.05 ? lastVolume : 0.8;
          this.player.setVolume(restored);
          updateVolumeUI(restored);
        }
      });
    }

    // Dismiss floating volume tray when tapping anywhere outside
    document.addEventListener('click', (e) => {
      if (this.volumeContainer && this.volumeContainer.classList.contains('tray-active')) {
        if (!this.volumeContainer.contains(e.target)) {
          this.volumeContainer.classList.remove('tray-active');
        }
      }
    });

    // Timeline Scrubber
    if (this.scrubberTrack) {
      const seekAtClientX = (clientX) => {
        if (this.isGuestLocked('seeking')) return;
        if (!this.currentTrack || !this.player.duration) return;
        const rect = this.scrubberTrack.getBoundingClientRect();
        const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const newTime = pos * this.player.duration;
        this.player.seek(newTime);
      };

      this.scrubberTrack.addEventListener('click', (e) => seekAtClientX(e.clientX));
      this.scrubberTrack.addEventListener('touchstart', (e) => {
        if (this.isGuestLocked('seeking')) return;
        if (e.touches && e.touches[0]) {
          this.isScrubbing = true;
          seekAtClientX(e.touches[0].clientX);
        }
      }, { passive: true });
      this.scrubberTrack.addEventListener('touchmove', (e) => {
        if (this.isGuestLocked('seeking')) return;
        if (this.isScrubbing && e.touches && e.touches[0]) {
          seekAtClientX(e.touches[0].clientX);
        }
      }, { passive: true });
      this.scrubberTrack.addEventListener('touchend', () => {
        this.isScrubbing = false;
      });
    }

    // Fullscreen / Clean Record Mode Toggle & Punchhole Protection
    if (this.btnToggleFullscreen) {
      this.btnToggleFullscreen.addEventListener('click', () => {
        const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || (this.appEl && this.appEl.classList.contains('is-fullscreen')));
        if (!isFs) {
          if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => {
              this.setFullscreenMode(true);
            });
          } else if (document.documentElement.webkitRequestFullscreen) {
            document.documentElement.webkitRequestFullscreen();
          } else {
            this.setFullscreenMode(true);
          }
        } else {
          if (document.exitFullscreen && (document.fullscreenElement || document.webkitFullscreenElement)) {
            document.exitFullscreen().catch(() => {});
          } else if (document.webkitExitFullscreen && (document.fullscreenElement || document.webkitFullscreenElement)) {
            document.webkitExitFullscreen();
          }
          this.setFullscreenMode(false);
        }
      });
    }

    const updateFullscreenState = () => {
      const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      this.setFullscreenMode(isFs);
    };
    document.addEventListener('fullscreenchange', updateFullscreenState);
    document.addEventListener('webkitfullscreenchange', updateFullscreenState);

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (this.isGuestLocked('playback')) return;
        this.player.togglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        if (this.isGuestLocked('seeking')) return;
        if (this.currentTrack) this.player.seek(this.player.currentTime - 5);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        if (this.isGuestLocked('seeking')) return;
        if (this.currentTrack) this.player.seek(this.player.currentTime + 5);
      } else if (e.code === 'KeyF' || e.code === 'KeyC') {
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
    [this.themeModal, this.trackModal, this.adminModal, this.submissionConfirmModal, this.listenTogetherModal, this.songDetailsModal].forEach(modal => {
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) modal.classList.remove('active');
        });
      }
    });

    // Song Details Modal Action Bindings
    if (this.btnDetailModalPlay) {
      this.btnDetailModalPlay.addEventListener('click', async () => {
        if (this._detailTrack) {
          if (this.currentTrack && this.currentTrack.id === this._detailTrack.id) {
            this.player.togglePlay();
          } else {
            await this.loadTrack(this._detailTrack, true);
          }
          if (this.songDetailsModal) this.songDetailsModal.classList.remove('active');
          this.renderHomePage();
        }
      });
    }
    if (this.btnDetailPlayNow) {
      this.btnDetailPlayNow.addEventListener('click', async () => {
        if (this._detailTrack) {
          if (this.currentTrack && this.currentTrack.id === this._detailTrack.id) {
            this.player.togglePlay();
          } else {
            await this.loadTrack(this._detailTrack, true);
          }
          if (this.songDetailsModal) this.songDetailsModal.classList.remove('active');
          this.renderHomePage();
        }
      });
    }
    if (this.btnDetailViewLyrics) {
      this.btnDetailViewLyrics.addEventListener('click', async () => {
        if (this._detailTrack) {
          if (!this.currentTrack || this.currentTrack.id !== this._detailTrack.id) {
            await this.loadTrack(this._detailTrack, true);
          }
          if (this.songDetailsModal) this.songDetailsModal.classList.remove('active');
          this.switchTab('lyrics');
        }
      });
    }
    if (this.btnDetailToggleFavorite) {
      this.btnDetailToggleFavorite.addEventListener('click', () => {
        if (this._detailTrack) {
          const isFav = this.toggleTrackFavorite(this._detailTrack.id);
          this.btnDetailToggleFavorite.classList.toggle('is-favorite', isFav);
          if (this.detailFavLabel) this.detailFavLabel.textContent = isFav ? 'Favorited' : 'Favorite';
        }
      });
    }
    if (this.btnDetailSaveOffline) {
      this.btnDetailSaveOffline.addEventListener('click', async () => {
        if (this._detailTrack) {
          try {
            if (this.detailSaveLabel) this.detailSaveLabel.textContent = 'Saving...';
            await Storage.downloadTrackForOffline(this._detailTrack);
            this.tracks = await Storage.getAllTracks();
            if (this.detailSaveLabel) this.detailSaveLabel.textContent = 'Saved';
            this.btnDetailSaveOffline.classList.add('downloaded');
            if (this.detailModalOfflineChip) {
              this.detailModalOfflineChip.textContent = 'Saved Offline';
              this.detailModalOfflineChip.className = 'detail-badge detail-badge-lrc';
            }
            this.renderHomePage();
          } catch (e) {
            if (this.detailSaveLabel) this.detailSaveLabel.textContent = 'Failed';
            setTimeout(() => { if (this.detailSaveLabel) this.detailSaveLabel.textContent = 'Download'; }, 2000);
          }
        }
      });
    }
    if (this.btnDetailOpenLyricsEditor) {
      this.btnDetailOpenLyricsEditor.addEventListener('click', async () => {
        if (this._detailTrack) {
          if (!this.currentTrack || this.currentTrack.id !== this._detailTrack.id) {
            await this.loadTrack(this._detailTrack, false);
          }
          if (this.songDetailsModal) this.songDetailsModal.classList.remove('active');
          if (this.lrcEditor) this.lrcEditor.open();
        }
      });
    }

    // Listen Together Event Bindings
    if (this.btnOpenListenTogether) {
      this.btnOpenListenTogether.addEventListener('click', () => this.openListenTogetherModal());
    }
    if (this.btnManageActiveRoom) {
      this.btnManageActiveRoom.addEventListener('click', () => this.openListenTogetherModal());
    }
    if (this.btnCreateRoom) {
      this.btnCreateRoom.addEventListener('click', () => this.handleCreateRoom());
    }
    if (this.btnJoinRoom) {
      this.btnJoinRoom.addEventListener('click', () => this.handleJoinRoom());
    }
    if (this.inputJoinRoomCode) {
      this.inputJoinRoomCode.addEventListener('input', (e) => {
        let val = (e.target.value || '').toUpperCase();
        if (val.includes('ETHIO-')) {
          val = val.replace(/ETHIO-?/gi, '');
        }
        val = val.replace(/[^A-Z0-9]/g, '').slice(0, 4);
        e.target.value = val;
        if (this.joinRoomError) this.joinRoomError.style.display = 'none';
      });

      this.inputJoinRoomCode.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.handleJoinRoom();
        }
      });
    }
    if (this.btnEditParticipantName) {
      this.btnEditParticipantName.addEventListener('click', () => {
        const cur = this.myParticipant ? this.myParticipant.name : 'Music Lover';
        const entered = prompt('Enter your display name:', cur);
        if (entered && entered.trim()) {
          Storage.setParticipantName(entered.trim());
          this.myParticipant.name = entered.trim();
          if (this.currentParticipantNameLabel) {
            this.currentParticipantNameLabel.textContent = entered.trim();
          }
        }
      });
    }
    const shareModalBtn = this.btnShareInviteLinkModal || this.btnCopyInviteLinkModal;
    const shareModalLabel = this.shareInviteLinkModalLabel || this.copyInviteLinkModalLabel;
    if (shareModalBtn) {
      shareModalBtn.addEventListener('click', () => {
        this.shareRoomInvite(shareModalBtn, shareModalLabel);
      });
    }

    const shareRoomBtn = this.btnShareRoomLink || this.btnCopyRoomLink;
    const shareRoomLabel = this.shareLinkBtnText || this.copyLinkBtnText;
    if (shareRoomBtn) {
      shareRoomBtn.addEventListener('click', () => {
        this.shareRoomInvite(shareRoomBtn, shareRoomLabel);
      });
    }
    if (this.btnLeaveRoomModal) {
      this.btnLeaveRoomModal.addEventListener('click', () => this.handleLeaveRoom(true));
    }
    if (this.btnLeaveRoom) {
      this.btnLeaveRoom.addEventListener('click', () => this.handleLeaveRoom(true));
    }

    // Listen Together Audio Latency & Resync Controls
    if (this.sliderAudioDelay) {
      const currentDelay = Storage.getAudioDelayMs();
      this.sliderAudioDelay.value = currentDelay;
      if (this.audioDelayValueLabel) {
        this.audioDelayValueLabel.textContent = currentDelay > 0 ? `${currentDelay}ms (Compensated)` : '0ms (Direct)';
      }
      this.sliderAudioDelay.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10) || 0;
        if (this.audioDelayValueLabel) {
          this.audioDelayValueLabel.textContent = val > 0 ? `${val}ms (Compensated)` : '0ms (Direct)';
        }
        Storage.setAudioDelayMs(val);
        this.audioDelaySec = val / 1000;
      });
    }

    if (this.btnModalResync) {
      this.btnModalResync.addEventListener('click', () => {
        this.resyncGuestAudio();
      });
    }

    if (this.roomBarSyncChip) {
      this.roomBarSyncChip.addEventListener('click', () => {
        this.resyncGuestAudio();
      });
    }

    if (this.btnDebugClose) {
      this.btnDebugClose.addEventListener('click', () => {
        if (this.partySyncDebugOverlay) {
          this.partySyncDebugOverlay.style.display = 'none';
        }
      });
    }

    // Expandable Reaction Tray Toggle & Outside Click Handler
    if (this.btnToggleReactions) {
      this.btnToggleReactions.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = !this.reactionsDropdown || this.reactionsDropdown.style.display === 'none';
        if (this.reactionsDropdown) {
          this.reactionsDropdown.style.display = isHidden ? 'flex' : 'none';
        }
        this.btnToggleReactions.classList.toggle('active', isHidden);
      });
    }

    // Reaction buttons inside expandable tray
    document.querySelectorAll('.btn-reaction').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const type = btn.getAttribute('data-reaction') || 'fire';
        this.handleSendReaction(type);
        // Allow rapid multi-tap, then auto-close after 600ms
        clearTimeout(this._reactionCloseTimer);
        this._reactionCloseTimer = setTimeout(() => {
          if (this.reactionsDropdown) this.reactionsDropdown.style.display = 'none';
          if (this.btnToggleReactions) this.btnToggleReactions.classList.remove('active');
        }, 600);
      });
    });

    // Close reactions dropdown on clicking outside
    document.addEventListener('click', (e) => {
      if (this.reactionsDropdown && !e.target.closest('.room-reactions-wrapper')) {
        this.reactionsDropdown.style.display = 'none';
        if (this.btnToggleReactions) this.btnToggleReactions.classList.remove('active');
      }
    });

    window.addEventListener('beforeunload', () => {
      if (this.activeRoom && this.myParticipant) {
        FirebaseService.leaveListenRoom(this.activeRoom.roomCode, this.myParticipant.id);
      }
    });

    // Library Tab Switchers in Library View
    if (this.tabGlobalCatalog) {
      this.tabGlobalCatalog.addEventListener('click', () => this.switchLibraryTab('global'));
    }
    if (this.tabPlaylists) {
      this.tabPlaylists.addEventListener('click', () => this.switchLibraryTab('playlists'));
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
    const spotlightTrack = this.currentTrack || (this.publicTracks.length > 0 ? this.publicTracks[0] : (this.tracks.length > 0 ? this.tracks[0] : null));
    if (this.heroPlayLabel) {
      this.heroPlayLabel.textContent = isPlaying ? 'Pause Track' : 'Play Track';
    }
    if (this.btnHeroPlayBadge) {
      this.btnHeroPlayBadge.innerHTML = isPlaying 
        ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>' 
        : '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
    }
    if (spotlightTrack) {
      if (this.heroArtworkImg) {
        this.heroArtworkImg.src = spotlightTrack.cover || 'assets/weleta_cover.jpg';
      }
      if (this.heroTitle) this.heroTitle.textContent = spotlightTrack.title;
      if (this.heroArtist) this.heroArtist.textContent = spotlightTrack.artist;
      if (this.heroLrcBadge) {
        this.heroLrcBadge.textContent = spotlightTrack.lrc ? 'Synced LRC' : 'Audio';
      }
      if (this.heroDurationBadge) {
        const dur = this.getTrackDuration(spotlightTrack);
        this.heroDurationBadge.textContent = dur > 0 ? LyricsParser.formatTime(dur) : '3:45';
      }
    }
  }

  renderHomePage() {
    if (!this.homeExploreView) return;

    // 1. Live Greeting & Listening DNA Stats
    const greetingData = RecommendationEngine.getGreetingData();
    if (this.greetingMoodBadge) this.greetingMoodBadge.textContent = greetingData.badge;
    if (this.greetingMoodText) this.greetingMoodText.textContent = greetingData.amharicPeriod;
    if (this.greetingHeadingText) {
      const userFirstName = this.currentUser && this.currentUser.displayName ? this.currentUser.displayName.split(' ')[0] : 'Music Lover';
      this.greetingHeadingText.textContent = `${greetingData.greeting}, ${userFirstName}`;
    }
    if (this.greetingHeadingAmharic) this.greetingHeadingAmharic.textContent = greetingData.amharicGreeting;
    if (this.greetingSubtext) this.greetingSubtext.textContent = greetingData.subtitle;

    const allTracks = [...this.publicTracks, ...this.tracks];
    // Deduplicate by ID
    const uniquePool = [];
    const seenIds = new Set();
    for (const t of allTracks) {
      if (t && t.id && !seenIds.has(t.id)) {
        seenIds.add(t.id);
        uniquePool.push(t);
      }
    }

    const dnaStats = RecommendationEngine.getListeningStats(uniquePool, {
      favoriteIds: this.favorites || [],
      recentIds: this.recentlyPlayed || []
    });
    if (this.dnaStatTotal) this.dnaStatTotal.textContent = dnaStats.totalTracks;
    if (this.dnaStatLrc) this.dnaStatLrc.textContent = dnaStats.syncedLyricsCount;
    if (this.dnaStatFavs) this.dnaStatFavs.textContent = dnaStats.favoriteCount;

    // 2. Update Featured Spotlight
    this.updateHeroState();

    // 3. Jump Back In Shelf
    const jumpTracks = RecommendationEngine.getJumpBackIn(uniquePool, this.recentlyPlayed || []);
    this.renderJumpBackInGrid(jumpTracks);

    // 4. Iconic Artists Discovery Row
    const iconicArtists = RecommendationEngine.getIconicArtists(uniquePool);
    this.renderIconicArtistsRow(iconicArtists);

    // 5. Smart Recommendations Shelf ("Made For You")
    const recs = RecommendationEngine.getPersonalizedRecommendations(uniquePool, {
      currentTrack: this.currentTrack,
      recentIds: this.recentlyPlayed || [],
      favoriteIds: this.favorites || [],
      limit: 8
    });
    this.renderMusicGrid(this.gridSuggestions, recs, 'No personalized recommendations available yet. Play a song or like your favorites to tune your recommendations!');

    // 6. Context-Aware "Because You Listened To" Shelf
    const becauseShelf = RecommendationEngine.getBecauseYouListenedShelf(uniquePool, {
      recentIds: this.recentlyPlayed || [],
      currentTrack: this.currentTrack
    });
    if (this.sectionBecauseYouListened) {
      if (becauseShelf.tracks && becauseShelf.tracks.length > 0 && becauseShelf.sourceArtist) {
        this.sectionBecauseYouListened.style.display = 'block';
        if (this.becauseTitleText) this.becauseTitleText.textContent = `Because You Listened To ${becauseShelf.sourceArtist}`;
        if (this.becauseSubtitleText) this.becauseSubtitleText.textContent = `Handpicked gems inspired by ${becauseShelf.sourceArtist}`;
        this.renderMusicGrid(this.gridBecauseYouListened, becauseShelf.tracks, 'No similar tracks found.');
      } else {
        this.sectionBecauseYouListened.style.display = 'none';
      }
    }

    // 7. Verified Synced Lyrics Showcase Shelf
    const showcaseTracks = RecommendationEngine.getLyricsStageShowcase(uniquePool, 8);
    this.renderMusicGrid(this.gridLyricsShowcase, showcaseTracks, 'No synced lyrics tracks available.');

    // 8. Global Cloud Catalog Shelf (with search, category filter, and sorting)
    let catalogTracks = [...this.publicTracks];

    // Filter by Search Query
    if (this.searchQuery) {
      const q = this.searchQuery;
      catalogTracks = catalogTracks.filter(t =>
        (t.title && t.title.toLowerCase().includes(q)) ||
        (t.artist && t.artist.toLowerCase().includes(q)) ||
        (t.album && t.album.toLowerCase().includes(q))
      );
    }

    // Filter by Active Filter Chip
    if (this.activeFilter === 'favorites') {
      const favIds = this.favorites || [];
      catalogTracks = catalogTracks.filter(t => favIds.includes(t.id));
    } else if (this.activeFilter === 'recent') {
      const recentIds = this.recentlyPlayed || [];
      const ordered = [];
      recentIds.forEach(id => {
        const match = catalogTracks.find(t => t.id === id);
        if (match && !ordered.includes(match)) ordered.push(match);
      });
      catalogTracks = ordered;
    } else if (this.activeFilter === 'suggested') {
      catalogTracks = catalogTracks.filter(t => t.lrc && t.lrc.length > 20);
    } else if (this.activeFilter === 'classic') {
      catalogTracks = catalogTracks.filter(t => (t.album && t.album.toLowerCase().includes('classic')) || (parseInt(t.year) < 2010));
    } else if (this.activeFilter === 'pop') {
      catalogTracks = catalogTracks.filter(t => !t.year || parseInt(t.year) >= 2010);
    } else if (this.activeFilter === 'lrc') {
      catalogTracks = catalogTracks.filter(t => t.lrc && t.lrc.length > 10);
    } else if (this.activeFilter === 'offline') {
      catalogTracks = this.tracks;
    }

    // Sorting
    const sortMode = this.catalogSortOption || 'newest';
    if (sortMode === 'title') {
      catalogTracks.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    } else if (sortMode === 'artist') {
      catalogTracks.sort((a, b) => (a.artist || '').localeCompare(b.artist || ''));
    } else if (sortMode === 'year') {
      catalogTracks.sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0));
    } else if (sortMode === 'lrc') {
      catalogTracks.sort((a, b) => ((b.lrc ? b.lrc.length : 0) - (a.lrc ? a.lrc.length : 0)));
    }

    if (this.catalogCounterSubtitle) {
      this.catalogCounterSubtitle.textContent = `${catalogTracks.length} Ethiopian tracks ready to stream & download`;
    }

    this.renderMusicGrid(this.gridGlobalCatalog, catalogTracks, 'No cloud tracks found matching your criteria. Use Admin Studio to publish tracks!');

    // Personal Offline Catalog
    this.renderMusicGrid(this.gridPersonalCatalog, this.tracks, 'No offline tracks saved yet. Download songs from the catalog or upload your own in the library!');
  }

  renderJumpBackInGrid(jumpTracks) {
    if (!this.sectionJumpBackIn || !this.gridJumpBackIn) return;
    if (!jumpTracks || jumpTracks.length === 0) {
      this.sectionJumpBackIn.style.display = 'none';
      return;
    }
    this.sectionJumpBackIn.style.display = 'block';
    this.gridJumpBackIn.innerHTML = '';

    jumpTracks.forEach(track => {
      const isCurrent = this.currentTrack && this.currentTrack.id === track.id;
      const isPlaying = isCurrent && this.player.isPlaying;
      const card = document.createElement('div');
      card.className = `jump-card ${isCurrent ? 'playing' : ''}`;
      card.innerHTML = `
        <img src="${track.cover || 'assets/weleta_cover.jpg'}" alt="${track.title}" class="jump-card-art" crossorigin="anonymous" onerror="this.src='assets/weleta_cover.jpg'">
        <div class="jump-card-info">
          <div class="jump-card-title" title="${track.title}">${track.title}</div>
          <div class="jump-card-artist" title="${track.artist}">${track.artist}</div>
        </div>
        <button class="jump-card-play-btn" title="${isPlaying ? 'Pause' : 'Play'}" type="button">
          ${isPlaying 
            ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
            : '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>'}
        </button>
      `;

      card.addEventListener('click', async (e) => {
        if (e.target.closest('.jump-card-play-btn')) {
          e.stopPropagation();
        }
        if (isCurrent) {
          this.player.togglePlay();
        } else {
          const pool = [...this.publicTracks, ...this.tracks];
          this.setQueue(pool, pool.findIndex(t => t.id === track.id));
          await this.loadTrack(track, true);
        }
        this.renderHomePage();
      });

      this.gridJumpBackIn.appendChild(card);
    });
  }

  renderIconicArtistsRow(artists) {
    if (!this.sectionIconicArtists || !this.rowIconicArtists) return;
    if (!artists || artists.length === 0) {
      this.sectionIconicArtists.style.display = 'none';
      return;
    }
    this.sectionIconicArtists.style.display = 'block';
    this.rowIconicArtists.innerHTML = '';

    artists.forEach(artist => {
      const card = document.createElement('div');
      card.className = 'artist-circle-card';
      card.innerHTML = `
        <div class="artist-circle-avatar">
          <img src="${artist.cover || 'assets/weleta_cover.jpg'}" alt="${artist.name}" crossorigin="anonymous" onerror="this.src='assets/weleta_cover.jpg'">
        </div>
        <div class="artist-circle-name" title="${artist.name}">${artist.name}</div>
        <div class="artist-circle-tracks">${artist.trackCount} ${artist.trackCount === 1 ? 'song' : 'songs'}</div>
      `;

      card.addEventListener('click', () => {
        // Quick filter catalog by clicking artist avatar
        if (this.inputHomeSearch) {
          this.inputHomeSearch.value = artist.name;
          this.searchQuery = artist.name.toLowerCase();
          if (this.btnClearHomeSearch) this.btnClearHomeSearch.style.display = 'block';
          this.renderHomePage();
          if (this.sectionGlobalCatalog) {
            this.sectionGlobalCatalog.scrollIntoView({ behavior: 'smooth' });
          }
        }
      });

      this.rowIconicArtists.appendChild(card);
    });
  }

  getSmartSuggestions(tracksList) {
    return RecommendationEngine.getPersonalizedRecommendations(tracksList, {
      currentTrack: this.currentTrack,
      recentIds: this.recentlyPlayed || [],
      favoriteIds: this.favorites || [],
      limit: 8
    });
  }

  renderMusicGrid(container, tracks, emptyMessage) {
    if (!container) return;
    container.innerHTML = '';

    if (!tracks || tracks.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 2.5rem 1.5rem; text-align: center; color: var(--color-text-dim); font-size: 0.88rem; background: rgba(255,255,255,0.02); border-radius: 16px; border: 1px dashed rgba(255,255,255,0.08);">
          ${emptyMessage}
        </div>
      `;
      return;
    }

    tracks.forEach(track => {
      const isCurrent = this.currentTrack && this.currentTrack.id === track.id;
      const isPlaying = isCurrent && this.player.isPlaying;
      const isFav = this.favorites && this.favorites.includes(track.id);
      const dur = this.getTrackDuration(track);
      const durFormatted = dur > 0 ? LyricsParser.formatTime(dur) : '';

      const card = document.createElement('div');
      card.className = `music-card ${isCurrent ? 'playing' : ''}`;
      card.innerHTML = `
        <div class="card-art-wrap">
          <img src="${track.cover || 'assets/weleta_cover.jpg'}" alt="${track.title}" class="card-art-img" crossorigin="anonymous" onerror="this.src='assets/weleta_cover.jpg'">
          <div class="card-play-overlay">
            <div class="card-play-icon">${isPlaying ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>' : '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>'}</div>
          </div>
        </div>
        <div class="card-meta">
          <div class="card-title" title="${track.title}">${track.title}</div>
          <div class="card-artist" title="${track.artist}">${track.artist}</div>
          <div class="card-badges-row">
            <span class="card-badge ${track.lrc ? 'card-badge-lrc' : ''}">${track.lrc ? 'Synced LRC' : 'Audio'}</span>
            ${durFormatted ? `<span class="card-badge">${durFormatted}</span>` : ''}
            ${track.year ? `<span class="card-badge">${track.year}</span>` : ''}
          </div>
          <div class="card-tag-row">
            <div class="card-actions-row">
              <button class="card-btn-action btn-card-queue" title="Add to Queue" type="button">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
              </button>
              <button class="card-btn-action btn-card-playlist" title="Add to Playlist" type="button">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h7M3 6h.01M3 12h.01M3 18h.01M18 15v6m-3-3h6"/></svg>
              </button>
              <button class="card-btn-action btn-card-info" title="Preview Song Details" type="button">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              </button>
              <button class="card-btn-action btn-card-fav ${isFav ? 'is-favorite' : ''}" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}" type="button">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="${isFav ? '#ffffff' : 'none'}" stroke="#ffffff" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              </button>
              <button class="card-btn-action btn-card-download" title="Save for Offline" type="button">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>
            </div>
          </div>
        </div>
      `;

      // Play on card artwork click
      const artWrap = card.querySelector('.card-art-wrap');
      if (artWrap) {
        artWrap.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (isCurrent) {
            this.player.togglePlay();
          } else {
            this.setQueue(tracks, tracks.indexOf(track));
            await this.loadTrack(track, true);
          }
          this.renderHomePage();
        });
      }

      // Add to queue button
      const btnQueue = card.querySelector('.btn-card-queue');
      if (btnQueue) {
        btnQueue.addEventListener('click', (e) => {
          e.stopPropagation();
          this.addToQueue(track, false);
        });
      }

      // Add to playlist button
      const btnPlaylist = card.querySelector('.btn-card-playlist');
      if (btnPlaylist) {
        btnPlaylist.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openAddToPlaylistModal(track);
        });
      }

      // Info button
      const infoBtn = card.querySelector('.btn-card-info');
      if (infoBtn) {
        infoBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openSongDetails(track);
        });
      }

      // Favorite button
      const favBtn = card.querySelector('.btn-card-fav');
      if (favBtn) {
        favBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleTrackFavorite(track.id);
        });
      }

      // Download button
      const dlBtn = card.querySelector('.btn-card-download');
      if (dlBtn) {
        dlBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          dlBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
          try {
            await Storage.downloadTrackForOffline(track);
            dlBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
            dlBtn.title = 'Saved Offline';
            this.tracks = await Storage.getAllTracks();
          } catch (err) {
            dlBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
            setTimeout(() => { dlBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'; }, 2000);
          }
        });
      }

      // Open details on clicking the card
      card.addEventListener('click', (e) => {
        if (e.target.closest('.card-btn-action') || e.target.closest('.card-play-overlay')) return;
        this.openSongDetails(track);
      });

      container.appendChild(card);
    });
  }

  // --------------------------------------------------------------------------
  // Track Loading & Sync
  // --------------------------------------------------------------------------
  async loadTrack(track, autoPlay = true) {
    if (!this._isApplyingRemoteSync && this.isGuestLocked('track selection')) return;
    this.currentTrack = track;
    Storage.setLastTrackId(track.id);

    // Update Header Display on Lyrics Stage (Fix duplicate artist names)
    if (this.artistAmharic) this.artistAmharic.textContent = track.artist || 'Unknown Artist';
    if (this.artistEnglish) {
      // Only display transliteration if distinct from primary artist name
      const hasDistinctEn = track.artistEn && track.artistEn.trim().toLowerCase() !== (track.artist || '').trim().toLowerCase();
      if (hasDistinctEn) {
        this.artistEnglish.textContent = track.artistEn;
        this.artistEnglish.style.display = 'block';
      } else {
        this.artistEnglish.textContent = '';
        this.artistEnglish.style.display = 'none';
      }
    }
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
    const initialDur = this.getTrackDuration(track);
    this.updateTimeline(0, initialDur);

    if (autoPlay) {
      this.player.play();
    }

    // Record into recently played
    Storage.addRecentlyPlayed(track.id);
    this.recentlyPlayed = Storage.getRecentlyPlayed();
    this.updateFavoriteButtonsState();
    if (this.currentUser) {
      this.pushCloudSyncDebounced();
    }

    // Broadcast track change if Host
    if (this.activeRoom && this.isRoomHost && !this._isApplyingRemoteSync) {
      this.hostBroadcaster?.notify('track', { bumpEpoch: true });
    }

    this.updateHeroState();
  }

  renderEmptyLibraryState() {
    this.currentTrack = null;
    this.parsedLyrics = [];

    PaletteExtractor.applyToElement(this.appEl, PaletteExtractor.getDefaultPalette());

    if (this.artistAmharic) this.artistAmharic.textContent = 'የሙዚቃ ማጫወቻ';
    if (this.artistEnglish) {
      this.artistEnglish.textContent = 'ELM • ETHIO LYRICS MEDIA';
      this.artistEnglish.style.display = 'block';
    }
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

  getTrackDuration(track) {
    if (!track) return 0;
    if (this.currentTrack && this.currentTrack.id === track.id && this.player && this.player.duration && isFinite(this.player.duration) && this.player.duration > 0) {
      return this.player.duration;
    }
    if (track.duration && isFinite(track.duration) && track.duration > 0 && track.duration !== 180) {
      return track.duration;
    }
    if (track.lrc) {
      const est = LyricsParser.estimateDurationFromLrc(track.lrc);
      if (est > 0) return est;
    }
    if (track.duration && isFinite(track.duration) && track.duration > 0) {
      return track.duration;
    }
    return 0;
  }

  updateTimeline(currentTime, duration) {
    if (!this.currentTimeLabel || !this.durationLabel || !this.scrubberFill) return;
    const formattedCurrent = LyricsParser.formatTime(currentTime, '0:00');
    if (this.currentTimeLabel.textContent !== formattedCurrent) {
      this.currentTimeLabel.textContent = formattedCurrent;
    }
    const formattedDuration = (duration && duration > 0) ? LyricsParser.formatTime(duration, '--:--') : '--:--';
    if (this.durationLabel.textContent !== formattedDuration) {
      this.durationLabel.textContent = formattedDuration;
    }
    if (duration > 0) {
      const percent = Math.min(100, Math.max(0, (currentTime / duration) * 100));
      this.scrubberFill.style.width = `${percent}%`;
    } else {
      this.scrubberFill.style.width = '0%';
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

    if (this.tabGlobalCatalog) this.tabGlobalCatalog.classList.toggle('active', tab === 'global');
    if (this.tabPlaylists) this.tabPlaylists.classList.toggle('active', tab === 'playlists');
    if (this.tabOfflineLibrary) this.tabOfflineLibrary.classList.toggle('active', tab === 'offline');

    if (this.globalCatalogList) this.globalCatalogList.style.display = tab === 'global' ? 'flex' : 'none';
    if (this.playlistsContainer) this.playlistsContainer.style.display = tab === 'playlists' ? 'flex' : 'none';
    if (this.singlePlaylistView) this.singlePlaylistView.style.display = 'none';
    if (this.localTracksList) this.localTracksList.style.display = tab === 'offline' ? 'flex' : 'none';
    if (this.catalogSearchWrap) this.catalogSearchWrap.style.display = tab === 'playlists' ? 'none' : 'block';

    if (tab === 'global') {
      this.renderPublicCatalog(this.inputCatalogSearch ? this.inputCatalogSearch.value : '');
    } else if (tab === 'playlists') {
      this.renderPlaylists();
    } else {
      this.renderOfflineLibrary(this.inputCatalogSearch ? this.inputCatalogSearch.value : '');
    }
  }

  async renderPublicCatalog(filterText = '') {
    if (!this.globalCatalogList) return;
    this._catalogRenderToken = (this._catalogRenderToken || 0) + 1;
    const currentToken = this._catalogRenderToken;

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
      if (this._catalogRenderToken !== currentToken) return;
      const isCurrent = this.currentTrack && this.currentTrack.id === song.id;
      const isOfflineReady = await Storage.hasTrack(song.id);
      if (this._catalogRenderToken !== currentToken) return;

      const card = document.createElement('div');
      card.className = `theme-card-option ${isCurrent ? 'active' : ''}`;
      card.style.padding = '0.75rem 1rem';
      card.innerHTML = `
        <div class="track-info-clickable" style="display:flex; align-items:center; gap:0.75rem; flex:1; min-width:0; cursor:pointer;">
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
          <button class="btn-track-info btn-pill" style="font-size:0.75rem; padding:0.35rem 0.55rem;" title="Song Details">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          </button>
          <button class="btn-pill btn-download-offline ${isOfflineReady ? 'downloaded' : ''}" data-id="${song.id}">
            ${isOfflineReady ? 'Saved' : 'Download'}
          </button>
          ${this.isAdmin ? `<button class="btn-pill btn-delete-public" style="font-size:0.75rem; padding:0.35rem 0.55rem; color:#ff6b6b;" title="Delete from Global Catalog">&times;</button>` : ''}
        </div>
      `;

      card.querySelector('.track-info-clickable').addEventListener('click', (e) => {
        e.stopPropagation();
        this.openSongDetails(song);
      });

      const infoBtn = card.querySelector('.btn-track-info');
      if (infoBtn) {
        infoBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openSongDetails(song);
        });
      }

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

      card.addEventListener('click', () => {
        this.openSongDetails(song);
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
        <div class="track-info-clickable" style="display:flex; align-items:center; gap:0.75rem; flex:1; min-width:0; cursor:pointer;">
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
          <button class="btn-track-info btn-pill" style="font-size:0.75rem; padding:0.35rem 0.55rem;" title="Song Details">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          </button>
          <button class="btn-pill btn-edit-custom" style="font-size:0.75rem; padding:0.35rem 0.65rem;" title="Edit Metadata & Artwork">Edit</button>
          <button class="btn-pill btn-delete-custom" style="font-size:0.75rem; padding:0.35rem 0.55rem; color:#ff6b6b;" title="Delete Song">&times;</button>
        </div>
      `;

      card.querySelector('.track-info-clickable').addEventListener('click', (e) => {
        e.stopPropagation();
        this.openSongDetails(song);
      });

      const infoBtn = card.querySelector('.btn-track-info');
      if (infoBtn) {
        infoBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openSongDetails(song);
        });
      }

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

      card.addEventListener('click', () => {
        this.openSongDetails(song);
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

    // Apply the saved theme to app element immediately on startup
    this.themeManager.applyTheme(this.themeManager.currentTheme);

    const curTheme = THEMES.find(t => t.id === this.themeManager.currentTheme) || THEMES[0];
    const badgeLabel = document.getElementById('activeThemeBadgeLabel');
    const descText = document.getElementById('themeDescText');
    if (badgeLabel && curTheme) {
      badgeLabel.textContent = curTheme.name;
    }
    if (descText && curTheme) {
      descText.textContent = curTheme.description;
    }

    THEMES.forEach(t => {
      const card = document.createElement('div');
      const isActive = this.themeManager.currentTheme === t.id;
      card.className = `theme-compact-card ${isActive ? 'active' : ''}`;
      card.innerHTML = `
        <div class="theme-swatch-circle" style="background: ${t.previewGradient || 'var(--color-primary)'};"></div>
        <div class="theme-compact-name">${t.name}</div>
        <span class="theme-compact-badge">${t.badge}</span>
      `;
      card.title = `${t.name}: ${t.description}`;

      card.addEventListener('click', () => {
        this.themeManager.applyTheme(t.id);
        document.querySelectorAll('.theme-compact-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        if (badgeLabel) badgeLabel.textContent = t.name;
        if (descText) descText.textContent = t.description;
        if (this.themeModal) this.themeModal.classList.remove('active');
        if (this.currentUser) {
          this.pushCloudSyncDebounced();
        }
        requestAnimationFrame(() => {
          if (this.currentView === 'stage' || this.currentView === 'lyrics') {
            this.syncLyrics(this.player.currentTime);
          }
        });
      });
      this.themeOptionsList.appendChild(card);
    });

    // Keep active theme state in sync if cloud sync or anything else changes theme
    this.themeManager.onThemeChange((theme) => {
      document.querySelectorAll('.theme-compact-card').forEach(c => {
        const isMatch = c.querySelector('.theme-compact-name')?.textContent === theme.name;
        c.classList.toggle('active', isMatch);
      });
      if (badgeLabel) badgeLabel.textContent = theme.name;
      if (descText) descText.textContent = theme.description;
    });
  }

  // --------------------------------------------------------------------------
  // Cross-Device Cloud Sync Engine (Favorites, History, Themes & Playlists)
  // --------------------------------------------------------------------------
  async initCloudSync(userId) {
    if (!userId) return;

    if (this.syncStatusBadge) {
      this.syncStatusBadge.textContent = 'Syncing...';
    }

    try {
      // 1. Fetch remote cloud state from Firestore
      const remoteData = await FirebaseService.getUserSync(userId);

      if (remoteData) {
        // Merge favorites (Union of local and remote)
        const localFavs = Storage.getFavorites() || [];
        const remoteFavs = Array.isArray(remoteData.favorites) ? remoteData.favorites : [];
        const mergedFavs = Array.from(new Set([...remoteFavs, ...localFavs]));
        this.favorites = mergedFavs;
        Storage.setFavorites(mergedFavs);

        // Merge recently played (Combine preserving order)
        const localRecent = Storage.getRecentlyPlayed() || [];
        const remoteRecent = Array.isArray(remoteData.recentlyPlayed) ? remoteData.recentlyPlayed : [];
        const mergedRecent = Array.from(new Set([...remoteRecent, ...localRecent])).slice(0, 30);
        this.recentlyPlayed = mergedRecent;
        Storage.setRecentlyPlayed(mergedRecent);

        // Sync preferred theme if stored
        if (remoteData.preferredTheme && remoteData.preferredTheme !== this.themeManager.currentTheme) {
          this.themeManager.applyTheme(remoteData.preferredTheme);
          const badgeLabel = document.getElementById('activeThemeBadgeLabel');
          const tObj = THEMES.find(t => t.id === remoteData.preferredTheme);
          if (badgeLabel && tObj) badgeLabel.textContent = tObj.name;
        }

        // Push combined state back to cloud so both sides are completely reconciled
        await this.pushCloudSync(false);
      } else {
        // No remote document yet; push initial local state
        await this.pushCloudSync(false);
      }

      if (this.syncStatusBadge) {
        this.syncStatusBadge.textContent = 'Real-Time Active';
      }
      if (this.lastSyncedTimeLabel) {
        this.lastSyncedTimeLabel.textContent = `Last synced: ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }

      this.updateFavoriteButtonsState();
      this.renderHomePage();

      // 2. Subscribe to real-time changes across devices
      if (this.userSyncUnsubscribe) {
        this.userSyncUnsubscribe();
      }

      this.userSyncUnsubscribe = FirebaseService.subscribeUserSync(userId, (remote) => {
        if (!remote) return;
        let changed = false;

        if (Array.isArray(remote.favorites)) {
          const currentStr = JSON.stringify(this.favorites);
          const remoteStr = JSON.stringify(remote.favorites);
          if (currentStr !== remoteStr) {
            this.favorites = remote.favorites;
            Storage.setFavorites(remote.favorites);
            changed = true;
          }
        }

        if (Array.isArray(remote.recentlyPlayed)) {
          const currentStr = JSON.stringify(this.recentlyPlayed);
          const remoteStr = JSON.stringify(remote.recentlyPlayed);
          if (currentStr !== remoteStr) {
            this.recentlyPlayed = remote.recentlyPlayed;
            Storage.setRecentlyPlayed(remote.recentlyPlayed);
            changed = true;
          }
        }

        if (remote.preferredTheme && remote.preferredTheme !== this.themeManager.currentTheme) {
          this.themeManager.applyTheme(remote.preferredTheme);
          const badgeLabel = document.getElementById('activeThemeBadgeLabel');
          const tObj = THEMES.find(t => t.id === remote.preferredTheme);
          if (badgeLabel && tObj) badgeLabel.textContent = tObj.name;
        }

        if (this.lastSyncedTimeLabel) {
          this.lastSyncedTimeLabel.textContent = `Last synced: ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        }

        if (changed) {
          this.updateFavoriteButtonsState();
          if (this.activeFilter === 'favorites' || this.activeFilter === 'recent') {
            this.renderHomePage();
          }
        }
      });
    } catch (e) {
      console.warn('initCloudSync error:', e);
      if (this.syncStatusBadge) {
        this.syncStatusBadge.textContent = 'Offline (Local)';
      }
    }
  }

  async pushCloudSync(updateBadge = true) {
    if (!this.currentUser) return;
    try {
      this.isSyncing = true;
      const syncData = {
        favorites: Storage.getFavorites(),
        recentlyPlayed: Storage.getRecentlyPlayed(),
        playlists: Storage.getPlaylists(),
        preferredTheme: this.themeManager.currentTheme,
        lastActiveTrackId: this.currentTrack ? this.currentTrack.id : null,
      };

      await FirebaseService.saveUserSync(this.currentUser.uid, syncData);

      if (updateBadge && this.lastSyncedTimeLabel) {
        this.lastSyncedTimeLabel.textContent = `Last synced: ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }
    } catch (e) {
      console.warn('pushCloudSync error:', e);
    } finally {
      this.isSyncing = false;
    }
  }

  pushCloudSyncDebounced() {
    if (!this.currentUser) return;
    if (this._cloudSyncTimer) clearTimeout(this._cloudSyncTimer);
    this._cloudSyncTimer = setTimeout(() => {
      this.pushCloudSync(true);
    }, 1200);
  }

  async triggerManualSync() {
    if (!this.currentUser) {
      alert('Please sign in with Google to sync your favorites and music across devices.');
      return;
    }
    if (this.syncNowIcon) this.syncNowIcon.classList.add('sync-spinning');
    if (this.syncStatusBadge) {
      this.syncStatusBadge.textContent = 'Syncing...';
    }

    try {
      await this.pushCloudSync(true);
      if (this.syncStatusBadge) {
        this.syncStatusBadge.textContent = 'Synced!';
        setTimeout(() => {
          if (this.syncStatusBadge) this.syncStatusBadge.textContent = 'Real-Time Active';
        }, 1500);
      }
    } catch (err) {
      if (this.syncStatusBadge) this.syncStatusBadge.textContent = 'Sync Error';
    } finally {
      if (this.syncNowIcon) this.syncNowIcon.classList.remove('sync-spinning');
    }
  }

  toggleTrackFavorite(trackId) {
    if (!trackId) return;
    const isNowFav = Storage.toggleFavorite(trackId);
    this.favorites = Storage.getFavorites();
    this.updateFavoriteButtonsState();

    if (this.currentUser) {
      this.pushCloudSyncDebounced();
    }

    this.renderHomePage();
    return isNowFav;
  }

  updateFavoriteButtonsState() {
    const track = this.currentTrack || (this.publicTracks.length > 0 ? this.publicTracks[0] : (this.tracks.length > 0 ? this.tracks[0] : null));
    const isFav = track ? Storage.isFavorite(track.id) : false;

    [this.btnDockFavorite, this.btnHeroFavorite, this.btnLyricsFavorite].forEach(btn => {
      if (!btn) return;
      if (isFav) {
        btn.classList.add('is-favorite');
        btn.title = 'Remove from Favorites';
      } else {
        btn.classList.remove('is-favorite');
        btn.title = 'Add to Favorites';
      }
    });

    if (this.lyricsFavText) {
      this.lyricsFavText.textContent = isFav ? 'Favorited' : 'Favorite';
    }

    if (this._detailTrack && this.btnDetailToggleFavorite) {
      const isDetailFav = Storage.isFavorite(this._detailTrack.id);
      this.btnDetailToggleFavorite.classList.toggle('is-favorite', isDetailFav);
      if (this.detailFavLabel) this.detailFavLabel.textContent = isDetailFav ? 'Favorited' : 'Favorite';
    }
  }

  // --------------------------------------------------------------------------
  // Song Details Modal & Lyric Excerpt Preview
  // --------------------------------------------------------------------------
  async openSongDetails(track) {
    if (!track || !this.songDetailsModal) return;
    this._detailTrack = track;

    if (this.detailModalCover) {
      this.detailModalCover.src = track.cover || 'assets/weleta_cover.jpg';
    }
    if (this.detailModalTitle) {
      this.detailModalTitle.textContent = track.title || 'Untitled Track';
    }
    if (this.detailModalArtist) {
      this.detailModalArtist.textContent = track.artist || 'Unknown Artist';
    }
    if (this.detailModalArtistEn) {
      const hasDistinctEn = track.artistEn && track.artistEn.trim().toLowerCase() !== (track.artist || '').trim().toLowerCase();
      if (hasDistinctEn) {
        this.detailModalArtistEn.textContent = track.artistEn;
        this.detailModalArtistEn.style.display = 'block';
      } else {
        this.detailModalArtistEn.textContent = '';
        this.detailModalArtistEn.style.display = 'none';
      }
    }
    if (this.detailModalAlbum) {
      this.detailModalAlbum.textContent = `${track.album || 'Single'} • ${track.year || '2024'}`;
    }

    // LRC status & lyrics preview snippet
    const hasLrc = !!(track.lrc && track.lrc.trim());
    if (this.detailModalLrcChip) {
      this.detailModalLrcChip.textContent = hasLrc ? 'Synced LRC Lyrics' : 'Audio Track';
      this.detailModalLrcChip.className = `detail-badge ${hasLrc ? 'detail-badge-lrc' : 'detail-badge-offline'}`;
    }

    if (this.detailModalLyricsSnippet) {
      if (hasLrc) {
        // Strip timestamps for a clean text preview
        const lines = track.lrc.split('\n')
          .map(l => l.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim())
          .filter(l => l.length > 0)
          .slice(0, 5);
        this.detailModalLyricsSnippet.textContent = lines.join('\n') || 'No readable lyrics lines.';
      } else {
        this.detailModalLyricsSnippet.innerHTML = '<span style="color:var(--color-text-dim); font-style:italic;">No synchronized lyrics for this song yet. Tap "Edit LRC" to add lyrics.</span>';
      }
    }

    // Offline status
    const isOffline = await Storage.hasTrack(track.id);
    if (this.detailModalOfflineChip) {
      this.detailModalOfflineChip.textContent = isOffline ? 'Saved Offline' : 'Cloud Stream';
      this.detailModalOfflineChip.className = `detail-badge ${isOffline ? 'detail-badge-lrc' : 'detail-badge-offline'}`;
    }
    if (this.detailSaveLabel) {
      this.detailSaveLabel.textContent = isOffline ? 'Saved' : 'Download';
    }
    if (this.btnDetailSaveOffline) {
      this.btnDetailSaveOffline.classList.toggle('downloaded', isOffline);
    }

    // Favorite status
    const isFav = Storage.isFavorite(track.id);
    if (this.btnDetailToggleFavorite) {
      this.btnDetailToggleFavorite.classList.toggle('is-favorite', isFav);
    }
    if (this.detailFavLabel) {
      this.detailFavLabel.textContent = isFav ? 'Favorited' : 'Favorite';
    }

    // Playing state
    const isPlayingThis = this.currentTrack && this.currentTrack.id === track.id && this.player.isPlaying;
    if (this.detailPlayNowLabel) {
      this.detailPlayNowLabel.textContent = isPlayingThis ? 'Pause' : 'Play Now';
    }

    this.songDetailsModal.classList.add('active');
  }

  // --------------------------------------------------------------------------
  // Fullscreen / Clean Screen-Recording Mode
  // --------------------------------------------------------------------------
  toggleFullscreenMode() {
    if (this.btnToggleFullscreen) {
      this.btnToggleFullscreen.click();
    }
  }

  setFullscreenMode(active) {
    if (!this.appEl) return;
    this.appEl.classList.toggle('is-fullscreen', active);
    this.appEl.classList.toggle('creator-recording-mode', active);
    document.body.classList.toggle('is-fullscreen', active);

    if (this.tiktokWatermark) {
      this.tiktokWatermark.style.display = (active && (!this.activeTab || this.activeTab === 'lyrics')) ? 'block' : 'none';
    }

    if (this.btnToggleFullscreen) {
      this.btnToggleFullscreen.title = active ? 'Exit Fullscreen / Record Mode' : 'Fullscreen / Record Mode';
      this.btnToggleFullscreen.innerHTML = active
        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>`
        : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
    }

    if (active) {
      if (this.currentTrack && this.activeTab !== 'lyrics') {
        this.switchTab('lyrics');
      }
      requestAnimationFrame(() => {
        this.syncLyrics(this.player.currentTime);
      });
    }
  }

  // --------------------------------------------------------------------------
  // Listen Together (Party Room Management & Synchronization v2)
  // --------------------------------------------------------------------------
  isGuestLocked(actionName = 'playback') {
    if (this.activeRoom && !this.isRoomHost) {
      this.showToast(`Only the DJ controls ${actionName} 🎧`);
      return true;
    }
    return false;
  }

  openListenTogetherModal() {
    if (!this.listenTogetherModal) return;
    this.myParticipant = Storage.getParticipant(this.currentUser);
    if (this.currentParticipantNameLabel) {
      this.currentParticipantNameLabel.textContent = this.myParticipant.name;
    }

    if (this.activeRoom) {
      if (this.roomLobbyView) this.roomLobbyView.style.display = 'none';
      if (this.roomActiveView) this.roomActiveView.style.display = 'flex';
      this.updateListenRoomUI(this.activeRoom);
    } else {
      if (this.roomLobbyView) this.roomLobbyView.style.display = 'flex';
      if (this.roomActiveView) this.roomActiveView.style.display = 'none';
      if (this.joinRoomError) this.joinRoomError.style.display = 'none';
    }
    this.listenTogetherModal.classList.add('active');
  }

  async handleCreateRoom() {
    try {
      this.myParticipant = Storage.getParticipant(this.currentUser);
      if (this.btnCreateRoom) {
        this.btnCreateRoom.disabled = true;
        this.btnCreateRoom.textContent = 'Starting...';
      }

      await FirebaseService.calibrateServerTime();

      const currentTrack = this.currentTrack || (this.publicTracks.length > 0 ? this.publicTracks[0] : (this.tracks.length > 0 ? this.tracks[0] : null));
      const room = await FirebaseService.createListenRoom(
        this.myParticipant,
        currentTrack,
        this.player.isPlaying ? 'playing' : 'paused',
        this.player.currentTime || 0,
        this.player.getEffectivePlaybackRate ? this.player.getEffectivePlaybackRate() : 1.0
      );

      this.activeRoom = room;
      this.isRoomHost = true;
      document.body.classList.remove('is-party-guest');

      this.initHostBroadcaster();
      this.startPresenceHeartbeat(room.roomCode, true);
      this.subscribeToRoom(room.roomCode);

      this.updateListenRoomUI(room);
      this.updateSyncChipUI({ state: 'host' });

      if (this.btnCreateRoom) {
        this.btnCreateRoom.disabled = false;
        this.btnCreateRoom.textContent = 'Start Session';
      }
    } catch (err) {
      alert('Could not start live session: ' + err.message);
      if (this.btnCreateRoom) {
        this.btnCreateRoom.disabled = false;
        this.btnCreateRoom.textContent = 'Start Session';
      }
    }
  }

  initHostBroadcaster() {
    if (this.hostBroadcaster) {
      this.hostBroadcaster.stop();
    }
    this.hostBroadcaster = new HostBroadcaster({
      getState: () => ({
        trackId: this.currentTrack ? this.currentTrack.id : null,
        state: this.player.isPlaying ? 'playing' : 'paused',
        positionSec: this.player.currentTime || 0,
        rate: this.player.playbackRate || 1.0,
      }),
      publish: async (anchor, meta) => {
        if (!this.activeRoom) return;
        const currentTrack = this.currentTrack ? {
          id: this.currentTrack.id,
          title: this.currentTrack.title,
          artist: this.currentTrack.artist,
          album: this.currentTrack.album || 'Single',
          year: this.currentTrack.year || '2024',
          cover: this.currentTrack.cover || 'assets/weleta_cover.jpg',
          audioUrl: this.currentTrack.audioUrl || '',
          lrc: this.currentTrack.lrc || ''
        } : null;
        await FirebaseService.publishPlaybackAnchor(this.activeRoom.roomCode, anchor, {
          currentTrack: currentTrack,
          playbackState: anchor.state,
          positionSec: anchor.positionSec,
          clientTimestamp: anchor.anchorServerMs,
          epoch: anchor.epoch
        });
      },
      clock: { now: () => FirebaseService.getServerNow() },
      getLatencySec: () => this.audioDelaySec || 0,
    });
    this.hostBroadcaster.start();
  }

  initGuestSyncEngine() {
    if (this.guestSync) {
      this.guestSync.stop();
    }
    const playerAdapter = {
      getPosition: () => this.player.currentTime || 0,
      isPlaying: () => !!this.player.isPlaying,
      getDuration: () => this.player.duration || 0,
      seek: (sec) => this.player.seek(sec),
      play: () => this.player.play(),
      pause: () => this.player.pause(),
      setRateMultiplier: (m) => this.player.setSyncRateMultiplier(m),
      setBaseRate: (r) => this.player.setPlaybackRate(r),
    };
    this.guestSync = new GuestSyncEngine({
      player: playerAdapter,
      clock: { now: () => FirebaseService.getServerNow() },
      getLatencySec: () => this.audioDelaySec || 0,
      onStatus: (status) => {
        this.updateSyncChipUI(status);
        if (this.partySyncDebugOverlay && this.partySyncDebugOverlay.style.display !== 'none') {
          const debugInfo = this.guestSync.getDebugInfo();
          this.updateDebugOverlay(debugInfo);
        }
      }
    });
    this.guestSync.setTrackReady(!!this.currentTrack);
    this.guestSync.start();
  }

  startPresenceHeartbeat(roomCode, isHost) {
    this.stopPresenceHeartbeat();
    const sendPulse = async () => {
      if (!this.activeRoom || !this.myParticipant) return;
      const drift = this.guestSync ? Math.round(this.guestSync.lastDriftSec * 1000) : 0;
      await FirebaseService.heartbeatPresence(roomCode, this.myParticipant.id, drift);
    };

    sendPulse();

    this.presenceHeartbeatTimer = setInterval(async () => {
      if (!this.activeRoom || !this.myParticipant) return;
      await sendPulse();

      // Host Failover: if we are a guest, check if host is dark (> 90s)
      if (!this.isRoomHost && Array.isArray(this.presenceParticipants) && this.presenceParticipants.length > 0) {
        const now = Date.now();
        const hostP = this.presenceParticipants.find(p => p.isHost);
        const hostIsDark = !hostP || (now - (hostP.lastSeen?.toMillis ? hostP.lastSeen.toMillis() : (hostP.lastSeenMs || 0)) > 90000);
        if (hostIsDark) {
          const alive = this.presenceParticipants.filter(p => {
            const seen = p.lastSeen?.toMillis ? p.lastSeen.toMillis() : (p.lastSeenMs || 0);
            return (now - seen) <= 90000;
          });
          alive.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
          if (alive.length > 0 && alive[0].id === this.myParticipant.id) {
            console.log('[PartySync] Host timed out. Claiming host as oldest active participant...');
            try {
              const claimed = await FirebaseService.claimHost(roomCode, this.myParticipant);
              if (claimed) {
                this.isRoomHost = true;
                document.body.classList.remove('is-party-guest');
                if (this.guestSync) { this.guestSync.stop(); this.guestSync = null; }
                this.initHostBroadcaster();
                this.updateSyncChipUI({ state: 'host' });
                this.showToast('Session host disconnected. You are now the DJ 👑');
              }
            } catch (err) {
              console.warn('[PartySync] Host takeover attempt failed:', err);
            }
          }
        }
      }
    }, 30000);
  }

  stopPresenceHeartbeat() {
    if (this.presenceHeartbeatTimer) {
      clearInterval(this.presenceHeartbeatTimer);
      this.presenceHeartbeatTimer = null;
    }
  }

  async handleJoinRoom(code = null) {
    const rawCode = code || (this.inputJoinRoomCode ? this.inputJoinRoomCode.value : '');
    const cleanCode = (rawCode || '').trim().toUpperCase();

    // Extract the 4-char suffix (e.g. S4XS) whether user typed S4XS or ETHIO-S4XS
    const suffix = cleanCode.replace(/^ETHIO-?/i, '').replace(/[^A-Z0-9]/g, '');
    let fullTargetCode = '';

    if (suffix.length === 4) {
      fullTargetCode = `ETHIO-${suffix}`;
    } else if (cleanCode.startsWith('ETHIO-') && cleanCode.length === 10) {
      fullTargetCode = cleanCode;
    } else if (suffix.length > 0) {
      fullTargetCode = `ETHIO-${suffix}`;
    }

    if (!suffix || suffix.length < 4) {
      if (this.joinRoomError) {
        this.joinRoomError.textContent = 'Please enter a 4-character room code (e.g. S4XS).';
        this.joinRoomError.style.display = 'block';
      }
      return;
    }

    if (this.btnJoinRoom) {
      this.btnJoinRoom.disabled = true;
      this.btnJoinRoom.textContent = 'Joining...';
    }
    if (this.joinRoomError) this.joinRoomError.style.display = 'none';

    try {
      this.myParticipant = Storage.getParticipant(this.currentUser);
      await FirebaseService.calibrateServerTime();

      const room = await FirebaseService.joinListenRoom(fullTargetCode, this.myParticipant);

      this.activeRoom = room;
      this.isRoomHost = room.hostId === this.myParticipant.id;

      if (this.isRoomHost) {
        document.body.classList.remove('is-party-guest');
        this.initHostBroadcaster();
        this.updateSyncChipUI({ state: 'host' });
      } else {
        document.body.classList.add('is-party-guest');
        this.initGuestSyncEngine();
        this.updateSyncChipUI({ state: 'synced' });
      }

      this.startPresenceHeartbeat(room.roomCode, this.isRoomHost);
      this.subscribeToRoom(room.roomCode);
      this.updateListenRoomUI(room);

      if (this.btnJoinRoom) {
        this.btnJoinRoom.disabled = false;
        this.btnJoinRoom.textContent = 'Join';
      }
      if (this.inputJoinRoomCode) this.inputJoinRoomCode.value = '';
    } catch (err) {
      if (this.joinRoomError) {
        this.joinRoomError.textContent = err.message || 'Room not found or session has ended.';
        this.joinRoomError.style.display = 'block';
      }
      if (this.btnJoinRoom) {
        this.btnJoinRoom.disabled = false;
        this.btnJoinRoom.textContent = 'Join';
      }
    }
  }

  subscribeToRoom(roomCode) {
    if (this.roomUnsubscribe) {
      this.roomUnsubscribe();
      this.roomUnsubscribe = null;
    }
    if (this.roomParticipantsUnsubscribe) {
      this.roomParticipantsUnsubscribe();
      this.roomParticipantsUnsubscribe = null;
    }
    if (this.roomReactionsUnsubscribe) {
      this.roomReactionsUnsubscribe();
      this.roomReactionsUnsubscribe = null;
    }

    // 1. Room document listener (state & anchor)
    this.roomUnsubscribe = FirebaseService.subscribeListenRoom(roomCode, async (room) => {
      if (!room || room.isActive === false) {
        alert('The host has ended this Listen Together session.');
        this.handleLeaveRoom(false);
        return;
      }

      this.activeRoom = room;
      const isHostNow = room.hostId === this.myParticipant.id;

      if (isHostNow !== this.isRoomHost) {
        this.isRoomHost = isHostNow;
        if (isHostNow) {
          document.body.classList.remove('is-party-guest');
          if (this.guestSync) { this.guestSync.stop(); this.guestSync = null; }
          this.initHostBroadcaster();
          this.updateSyncChipUI({ state: 'host' });
          this.showToast('You are now the Session Host (DJ) 👑');
        } else {
          document.body.classList.add('is-party-guest');
          if (this.hostBroadcaster) { this.hostBroadcaster.stop(); this.hostBroadcaster = null; }
          this.initGuestSyncEngine();
          this.updateSyncChipUI({ state: 'synced' });
        }
      }

      this.updateListenRoomUI(room);

      // Guest Playback Synchronization
      if (!this.isRoomHost && room.currentTrack) {
        if (!this.currentTrack || this.currentTrack.id !== room.currentTrack.id) {
          this._isApplyingRemoteSync = true;
          const existing = [...this.publicTracks, ...this.tracks].find(t => t.id === room.currentTrack.id);
          const trackToLoad = existing || {
            id: room.currentTrack.id,
            title: room.currentTrack.title,
            artist: room.currentTrack.artist,
            album: room.currentTrack.album || 'Single',
            year: room.currentTrack.year || '2024',
            cover: room.currentTrack.cover || 'assets/weleta_cover.jpg',
            audioUrl: room.currentTrack.audioUrl || '',
            lrc: room.currentTrack.lrc || ''
          };

          await this.loadTrack(trackToLoad, false);
          this._isApplyingRemoteSync = false;
          if (this.guestSync) this.guestSync.setTrackReady(true);
        }

        const pb = room.playback || {
          trackId: room.currentTrack?.id,
          state: room.playbackState || 'paused',
          positionSec: room.positionSec || 0,
          anchorServerMs: room.anchorServerMs !== undefined ? room.anchorServerMs : (room.clientTimestamp || FirebaseService.getServerNow()),
          rate: room.playbackRate || 1.0,
          epoch: room.epoch || 1
        };

        if (this.guestSync) {
          this.guestSync.setAnchor({
            trackId: pb.trackId || room.currentTrack?.id,
            state: pb.state || room.playbackState || 'paused',
            positionSec: pb.positionSec ?? (room.positionSec || 0),
            anchorServerMs: pb.anchorServerMs ?? (room.clientTimestamp || FirebaseService.getServerNow()),
            rate: pb.rate ?? (room.playbackRate || 1.0),
            epoch: pb.epoch ?? (room.epoch || 1),
          });
        }
      }
    });

    // 2. Participants subcollection listener
    this.roomParticipantsUnsubscribe = FirebaseService.subscribeParticipants(roomCode, (participants) => {
      this.presenceParticipants = participants;
      this.renderParticipantsList(participants);
    });

    // 3. Reactions subcollection listener
    this.roomReactionsUnsubscribe = FirebaseService.subscribeReactions(roomCode, Date.now() - 1000, (rx) => {
      if (!this._seenReactionIds.has(rx.id)) {
        this._seenReactionIds.add(rx.id);
        const myName = this.myParticipant ? this.myParticipant.name : '';
        if (rx.from && rx.from !== myName) {
          this.renderFloatingReaction(rx.type, rx.from);
        }
      }
    });
  }

  renderParticipantsList(participants) {
    const list = Array.isArray(participants) && participants.length > 0 
      ? participants 
      : (this.activeRoom?.participants || []);
    const pCount = list.length;

    if (this.roomBarListenersLabel) {
      this.roomBarListenersLabel.textContent = `${pCount} listening together`;
    }
    if (this.activeRoomCountBadge) {
      this.activeRoomCountBadge.textContent = `${pCount} in room`;
    }
    if (this.activeRoomParticipantsList) {
      this.activeRoomParticipantsList.innerHTML = '';
      list.forEach(p => {
        const isCurrent = p.id === (this.myParticipant ? this.myParticipant.id : '');
        const pEl = document.createElement('div');
        pEl.className = 'participant-item';
        pEl.innerHTML = `
          <div class="participant-user-info">
            ${p.avatar ? `<img src="${p.avatar}" alt="${p.name || 'Participant'}" class="participant-avatar-img" crossorigin="anonymous">` : `<div class="participant-avatar-badge">${(p.name || 'M')[0].toUpperCase()}</div>`}
            <div>
              <div style="font-weight:600; font-size:0.88rem; color:#fff;">${p.name || 'Listener'} ${isCurrent ? '<span style="color:var(--color-gold); font-size:0.75rem;">(You)</span>' : ''}</div>
              <div style="font-size:0.7rem; color:var(--color-text-dim);">${p.isHost ? 'Session Host' : 'Listener'}</div>
            </div>
          </div>
          ${p.isHost ? `<span class="room-role-pill" style="font-size:0.65rem;">DJ</span>` : ''}
        `;
        this.activeRoomParticipantsList.appendChild(pEl);
      });
    }
  }

  resyncGuestAudio() {
    if (!this.activeRoom) return;
    if (this.isRoomHost) {
      this.showToast('You are the DJ 👑 (Broadcasting)');
      return;
    }
    if (this.guestSync) {
      this.guestSync.unlockFromGesture();
      this.showToast('Resyncing audio with DJ... 🎧');
    }
  }

  updateSyncChipUI(status) {
    if (!this.roomBarSyncChip || !this.roomBarSyncChipText) return;
    if (!this.activeRoom) {
      this.roomBarSyncChip.style.display = 'none';
      return;
    }
    this.roomBarSyncChip.style.display = 'inline-flex';

    if (this.isRoomHost) {
      this.roomBarSyncChip.className = 'room-sync-chip status-host';
      this.roomBarSyncChipText.textContent = 'DJ 👑';
      this.roomBarSyncChip.title = 'You are the DJ (Live Host)';
      return;
    }

    const state = status?.state || 'in-sync';
    const driftMs = Math.round(status?.driftMs || 0);
    this.roomBarSyncChip.classList.remove('status-insync', 'status-adjusting', 'status-seeking', 'status-buffering', 'status-host');

    switch (state) {
      case 'in-sync':
        this.roomBarSyncChip.classList.add('status-insync');
        this.roomBarSyncChipText.textContent = Math.abs(driftMs) > 0 ? `In sync (±${Math.abs(driftMs)}ms)` : 'In sync';
        this.roomBarSyncChip.title = `Synchronized within ${Math.abs(driftMs)}ms. Click to hard resync.`;
        break;
      case 'syncing':
        this.roomBarSyncChip.classList.add('status-adjusting');
        this.roomBarSyncChipText.textContent = `Nudging (${driftMs > 0 ? '+' : ''}${driftMs}ms)`;
        this.roomBarSyncChip.title = `Micro-adjusting tempo to align audio. Click to hard resync.`;
        break;
      case 'buffering':
      case 'waiting-host':
        this.roomBarSyncChip.classList.add('status-buffering');
        this.roomBarSyncChipText.textContent = 'Buffering...';
        this.roomBarSyncChip.title = 'Waiting for audio buffer...';
        break;
      case 'blocked':
        this.roomBarSyncChip.classList.add('status-seeking');
        this.roomBarSyncChipText.textContent = 'Tap to Play 🎧';
        this.roomBarSyncChip.title = 'Autoplay blocked. Tap to start synchronized audio.';
        break;
      case 'paused':
        this.roomBarSyncChip.classList.add('status-insync');
        this.roomBarSyncChipText.textContent = 'Paused';
        this.roomBarSyncChip.title = 'DJ paused playback';
        break;
      case 'loading':
        this.roomBarSyncChip.classList.add('status-buffering');
        this.roomBarSyncChipText.textContent = 'Loading...';
        this.roomBarSyncChip.title = 'Loading track...';
        break;
      default:
        this.roomBarSyncChip.classList.add('status-insync');
        this.roomBarSyncChipText.textContent = 'Party Mode';
        break;
    }
  }

  initDebugOverlay() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('syncdebug') === '1' && this.partySyncDebugOverlay) {
      this.partySyncDebugOverlay.style.display = 'block';
      this.debugSparklineHistory = [];
    }
  }

  updateDebugOverlay(info) {
    if (!this.partySyncDebugOverlay || this.partySyncDebugOverlay.style.display === 'none') return;
    const offset = FirebaseService.getClockOffset();
    const bestRtt = FirebaseService.getBestRtt();
    if (this.dbgClockOffset) this.dbgClockOffset.textContent = `${Math.round(offset)}ms`;
    if (this.dbgBestRtt) this.dbgBestRtt.textContent = `${Math.round(bestRtt)}ms`;
    if (this.dbgStatus) this.dbgStatus.textContent = info.state || '--';
    if (this.dbgDrift) this.dbgDrift.textContent = `${Math.round(info.driftMs || 0)}ms`;
    if (this.dbgMedian) this.dbgMedian.textContent = `${Math.round(info.medianMs || info.driftMs || 0)}ms`;
    if (this.dbgRate) this.dbgRate.textContent = `${(info.rate || 1.0).toFixed(3)}x`;
    if (this.dbgEpochAction) this.dbgEpochAction.textContent = `ep:${info.anchor?.epoch ?? '--'} | ${info.lastAction || 'idle'}`;
    if (this.dbgSeekStats) this.dbgSeekStats.textContent = `lead:${Math.round(info.seekLeadMs || 0)}ms | snaps:${info.stats?.hardSeeks || 0}`;

    this.debugSparklineHistory.push(info.medianMs || info.driftMs || 0);
    if (this.debugSparklineHistory.length > 50) {
      this.debugSparklineHistory.shift();
    }
    this.renderDebugSparkline();
  }

  renderDebugSparkline() {
    if (!this.dbgSparkline) return;
    const ctx = this.dbgSparkline.getContext('2d');
    if (!ctx) return;
    const w = this.dbgSparkline.width;
    const h = this.dbgSparkline.height;
    ctx.clearRect(0, 0, w, h);

    const midY = h / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    const maxRange = 150;
    const deadbandPx = (30 / maxRange) * (h / 2);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
    ctx.fillRect(0, midY - deadbandPx, w, deadbandPx * 2);

    const history = this.debugSparklineHistory;
    if (history.length < 2) return;

    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const step = w / 49;
    for (let i = 0; i < history.length; i++) {
      const val = history[i];
      const clampedVal = Math.max(-maxRange, Math.min(maxRange, val));
      const y = midY - (clampedVal / maxRange) * (midY - 3);
      const x = i * step;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const lastVal = history[history.length - 1];
    const absLast = Math.abs(lastVal);
    ctx.strokeStyle = absLast <= 30 ? '#10b981' : (absLast <= 100 ? '#f59e0b' : '#ef4444');
    ctx.stroke();
  }

  async handleLeaveRoom(notifyCloud = true) {
    this.stopPresenceHeartbeat();
    if (this.player.setSyncRateMultiplier) {
      this.player.setSyncRateMultiplier(1.0);
    }
    if (this.guestSync) {
      this.guestSync.stop();
      this.guestSync = null;
    }
    if (this.hostBroadcaster) {
      this.hostBroadcaster.stop();
      this.hostBroadcaster = null;
    }

    if (this.activeRoom && notifyCloud && this.myParticipant) {
      if (this.isRoomHost) {
        await FirebaseService.endListenRoom(this.activeRoom.roomCode);
      } else {
        await FirebaseService.leaveListenRoom(this.activeRoom.roomCode, this.myParticipant.id);
      }
    }
    if (this.roomUnsubscribe) {
      this.roomUnsubscribe();
      this.roomUnsubscribe = null;
    }
    if (this.roomParticipantsUnsubscribe) {
      this.roomParticipantsUnsubscribe();
      this.roomParticipantsUnsubscribe = null;
    }
    if (this.roomReactionsUnsubscribe) {
      this.roomReactionsUnsubscribe();
      this.roomReactionsUnsubscribe = null;
    }

    this.activeRoom = null;
    this.isRoomHost = false;
    this.presenceParticipants = [];
    this._seenReactionIds.clear();
    document.body.classList.remove('in-active-room');
    document.body.classList.remove('is-party-guest');

    if (this.activeListenRoomBar) this.activeListenRoomBar.style.display = 'none';
    if (this.roomBarSyncChip) this.roomBarSyncChip.style.display = 'none';
    if (this.btnOpenListenTogether) this.btnOpenListenTogether.classList.remove('active');
    if (this.liveRoomActiveIndicator) this.liveRoomActiveIndicator.style.display = 'none';
    if (this.roomLobbyView) this.roomLobbyView.style.display = 'flex';
    if (this.roomActiveView) this.roomActiveView.style.display = 'none';
    if (this.listenTogetherModal) this.listenTogetherModal.classList.remove('active');
  }

  updateListenRoomUI(room) {
    if (!room) return;
    document.body.classList.add('in-active-room');

    if (this.roomLobbyView) this.roomLobbyView.style.display = 'none';
    if (this.roomActiveView) this.roomActiveView.style.display = 'flex';

    if (this.activeListenRoomBar) this.activeListenRoomBar.style.display = 'flex';
    if (this.btnOpenListenTogether) this.btnOpenListenTogether.classList.add('active');
    if (this.liveRoomActiveIndicator) this.liveRoomActiveIndicator.style.display = 'inline-block';

    const isHost = room.hostId === (this.myParticipant ? this.myParticipant.id : '');

    if (this.roomBarCodeLabel) this.roomBarCodeLabel.textContent = room.roomCode;
    if (this.roomBarRolePill) {
      this.roomBarRolePill.textContent = isHost ? 'Host' : 'Listener';
      this.roomBarRolePill.style.background = isHost ? 'rgba(229,185,90,0.18)' : 'rgba(96,165,250,0.18)';
      this.roomBarRolePill.style.color = isHost ? '#fce7b2' : '#93c5fd';
      this.roomBarRolePill.style.borderColor = isHost ? 'rgba(229,185,90,0.4)' : 'rgba(96,165,250,0.4)';
    }

    if (this.activeRoomCodeTitle) this.activeRoomCodeTitle.textContent = room.roomCode;
    if (this.activeRoomRoleText) {
      this.activeRoomRoleText.textContent = isHost ? 'You are the Host (DJ)' : `Connected to DJ ${room.hostName || 'Host'}`;
    }

    if (room.currentTrack) {
      if (this.activeRoomTrackArt) this.activeRoomTrackArt.src = room.currentTrack.cover || 'assets/weleta_cover.jpg';
      if (this.activeRoomTrackTitle) this.activeRoomTrackTitle.textContent = room.currentTrack.title || 'Untitled';
      if (this.activeRoomTrackArtist) this.activeRoomTrackArtist.textContent = room.currentTrack.artist || 'Unknown Artist';
      if (this.activeRoomTrackStateBadge) {
        const isPlaying = (room.playback?.state || room.playbackState) === 'playing';
        this.activeRoomTrackStateBadge.textContent = isPlaying ? 'Playing' : 'Paused';
        this.activeRoomTrackStateBadge.style.color = isPlaying ? '#6ee7b7' : 'var(--color-text-dim)';
      }
    }

    this.renderParticipantsList(this.presenceParticipants);

    if (this.btnLeaveRoomModal) {
      this.btnLeaveRoomModal.textContent = isHost ? 'End Session for All' : 'Leave Session';
    }
  }

  handleSendReaction(type) {
    if (!this.activeRoom) return;
    const btn = document.querySelector(`.btn-reaction[data-reaction="${type}"]`);
    if (btn) {
      btn.style.transform = 'scale(1.35)';
      setTimeout(() => { if (btn) btn.style.transform = ''; }, 180);
    }
    const name = this.myParticipant ? this.myParticipant.name : 'Friend';
    FirebaseService.sendRoomReaction(this.activeRoom.roomCode, {
      type: type,
      from: name,
      fromId: this.myParticipant ? this.myParticipant.id : ''
    });
    this.renderFloatingReaction(type, 'You');
  }

  renderFloatingReaction(type, fromName) {
    if (!this.reactionFloatingStage) return;

    const reactionEl = document.createElement('div');
    reactionEl.className = 'reaction-floating-item';
    
    let iconSvg = '';
    if (type === 'fire') {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="#f43f5e" stroke="#f43f5e" stroke-width="1"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>';
    } else if (type === 'heart') {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="#ec4899" stroke="#ec4899" stroke-width="1"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
    } else if (type === 'music') {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e5b95a" stroke-width="2.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
    } else {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>';
    }

    reactionEl.innerHTML = `
      ${iconSvg}
      <span class="reaction-from-name">${fromName}</span>
    `;

    const isMobile = window.innerWidth <= 680;
    const randomLeft = isMobile ? (52 + Math.random() * 38) : (20 + Math.random() * 60);
    reactionEl.style.left = `${randomLeft}%`;

    this.reactionFloatingStage.appendChild(reactionEl);

    setTimeout(() => {
      if (reactionEl.parentNode) {
        reactionEl.parentNode.removeChild(reactionEl);
      }
    }, 2400);
  }

  // ==========================================================================
  // Modern Audio Controls: Shuffle, Repeat, Queue & Sleep Timer
  // ==========================================================================

  showToast(message, duration = 2400) {
    let toast = document.getElementById('appGlobalToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'appGlobalToast';
      toast.className = 'app-global-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('visible');
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, duration);
  }

  initPlaybackModeUI() {
    if (this.btnShuffle) {
      this.btnShuffle.classList.toggle('active', this.shuffleMode);
      this.btnShuffle.title = `Shuffle (${this.shuffleMode ? 'On' : 'Off'})`;
    }
    if (this.btnRepeat) {
      this.btnRepeat.classList.toggle('active', this.repeatMode !== 'off');
      this.btnRepeat.classList.toggle('repeat-one', this.repeatMode === 'one');
      this.btnRepeat.title = `Repeat (${this.repeatMode === 'one' ? 'Single Track' : (this.repeatMode === 'all' ? 'All' : 'Off')})`;
    }
  }

  toggleShuffle() {
    this.shuffleMode = !this.shuffleMode;
    Storage.setShuffleState(this.shuffleMode);
    this.initPlaybackModeUI();

    if (this.shuffleMode && this.queue.length > 1) {
      // Keep played history and current track, shuffle upcoming
      const played = this.queue.slice(0, this.queueIndex + 1);
      const upcoming = this.queue.slice(this.queueIndex + 1);
      for (let i = upcoming.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]];
      }
      this.queue = [...played, ...upcoming];
      this.showToast('Shuffle: ON 🔀');
    } else {
      this.showToast('Shuffle: OFF');
    }
    this.updateQueueCountUI();
    if (this.queueDrawerModal && this.queueDrawerModal.classList.contains('active')) {
      this.renderQueueDrawer();
    }
  }

  toggleRepeat() {
    if (this.repeatMode === 'off') {
      this.repeatMode = 'all';
    } else if (this.repeatMode === 'all') {
      this.repeatMode = 'one';
    } else {
      this.repeatMode = 'off';
    }
    Storage.setRepeatState(this.repeatMode);
    this.initPlaybackModeUI();
    const label = this.repeatMode === 'one' ? 'Repeat 1 (Track)' : (this.repeatMode === 'all' ? 'Repeat All (Queue)' : 'Repeat OFF');
    this.showToast(`Repeat: ${label} 🔁`);
  }

  async playNextTrack() {
    if (this.repeatMode === 'one' && this.currentTrack) {
      this.player.seek(0);
      this.player.play();
      return;
    }

    if (this.queue.length > 0) {
      if (this.queueIndex < this.queue.length - 1) {
        this.queueIndex++;
        await this.loadTrack(this.queue[this.queueIndex], true);
      } else if (this.repeatMode === 'all') {
        this.queueIndex = 0;
        await this.loadTrack(this.queue[0], true);
      } else {
        const all = [...this.publicTracks, ...this.tracks];
        if (all.length > 1 && this.currentTrack) {
          const idx = all.findIndex(t => t.id === this.currentTrack.id);
          const next = all[(idx + 1) % all.length];
          if (next) await this.loadTrack(next, true);
        }
      }
    } else {
      const all = [...this.publicTracks, ...this.tracks];
      if (all.length > 1 && this.currentTrack) {
        const idx = all.findIndex(t => t.id === this.currentTrack.id);
        const next = all[(idx + 1) % all.length];
        if (next) await this.loadTrack(next, true);
      }
    }

    this.updateQueueCountUI();
    if (this.queueDrawerModal && this.queueDrawerModal.classList.contains('active')) {
      this.renderQueueDrawer();
    }
  }

  async playPrevTrack() {
    if (this.player.currentTime > 3.0) {
      this.player.seek(0);
      return;
    }

    if (this.queue.length > 0 && this.queueIndex > 0) {
      this.queueIndex--;
      await this.loadTrack(this.queue[this.queueIndex], true);
    } else if (this.queue.length > 0 && this.repeatMode === 'all') {
      this.queueIndex = this.queue.length - 1;
      await this.loadTrack(this.queue[this.queueIndex], true);
    } else {
      this.player.seek(0);
    }

    this.updateQueueCountUI();
    if (this.queueDrawerModal && this.queueDrawerModal.classList.contains('active')) {
      this.renderQueueDrawer();
    }
  }

  setQueue(tracksList, startIndex = 0) {
    if (!tracksList || tracksList.length === 0) return;
    this.queue = [...tracksList];
    this.queueIndex = Math.max(0, Math.min(startIndex, this.queue.length - 1));

    if (this.shuffleMode && this.queue.length > 1) {
      const current = this.queue[this.queueIndex];
      const rest = this.queue.filter((_, idx) => idx !== this.queueIndex);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      this.queue = [current, ...rest];
      this.queueIndex = 0;
    }

    this.updateQueueCountUI();
    if (this.queueDrawerModal && this.queueDrawerModal.classList.contains('active')) {
      this.renderQueueDrawer();
    }
  }

  addToQueue(track, playNext = false) {
    if (!track) return;
    if (playNext) {
      const insertIdx = Math.max(0, this.queueIndex + 1);
      this.queue.splice(insertIdx, 0, track);
      this.showToast(`"${track.title}" set to play next 🎵`);
    } else {
      this.queue.push(track);
      this.showToast(`Added "${track.title}" to Up Next 📋`);
    }
    this.updateQueueCountUI();
    if (this.queueDrawerModal && this.queueDrawerModal.classList.contains('active')) {
      this.renderQueueDrawer();
    }
  }

  removeFromQueue(index) {
    if (index < 0 || index >= this.queue.length) return;
    this.queue.splice(index, 1);
    if (index < this.queueIndex) {
      this.queueIndex--;
    }
    this.updateQueueCountUI();
    this.renderQueueDrawer();
  }

  clearQueue() {
    if (this.currentTrack) {
      this.queue = [this.currentTrack];
      this.queueIndex = 0;
    } else {
      this.queue = [];
      this.queueIndex = -1;
    }
    this.updateQueueCountUI();
    this.renderQueueDrawer();
    this.showToast('Up Next queue cleared');
  }

  updateQueueCountUI() {
    const upcomingCount = Math.max(0, this.queue.length - 1 - this.queueIndex);
    if (this.queueCountBadge) {
      this.queueCountBadge.textContent = upcomingCount;
      this.queueCountBadge.style.display = upcomingCount > 0 ? 'flex' : 'none';
    }
  }

  openQueueDrawer() {
    if (this.queueDrawerModal) {
      this.queueDrawerModal.classList.add('active');
      this.renderQueueDrawer();
    }
  }

  renderQueueDrawer() {
    if (!this.queueDrawerModal) return;

    if (this.currentTrack) {
      if (this.queueNowPlayingArt) this.queueNowPlayingArt.src = this.currentTrack.cover || 'assets/weleta_cover.jpg';
      if (this.queueNowPlayingTitle) this.queueNowPlayingTitle.textContent = this.currentTrack.title || 'Untitled';
      if (this.queueNowPlayingArtist) this.queueNowPlayingArtist.textContent = this.currentTrack.artist || 'Unknown Artist';
    }

    if (!this.queueUpcomingList) return;
    this.queueUpcomingList.innerHTML = '';

    const upcoming = this.queue.slice(this.queueIndex + 1);
    if (this.queueUpcomingCount) {
      this.queueUpcomingCount.textContent = `${upcoming.length} tracks`;
    }

    if (upcoming.length === 0) {
      this.queueUpcomingList.innerHTML = `
        <div style="text-align:center; padding:2rem 1rem; color:var(--color-text-dim); font-size:0.85rem;">
          No upcoming tracks in queue.<br>Play a playlist or album to queue songs!
        </div>
      `;
      return;
    }

    upcoming.forEach((track, relIdx) => {
      const actualIdx = this.queueIndex + 1 + relIdx;
      const item = document.createElement('div');
      item.className = 'queue-track-item';
      item.innerHTML = `
        <img src="${track.cover || 'assets/weleta_cover.jpg'}" alt="${track.title}" class="queue-thumb-img" crossorigin="anonymous" onerror="this.src='assets/weleta_cover.jpg'">
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600; font-size:0.88rem; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${track.title}</div>
          <div style="font-size:0.75rem; color:var(--color-text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${track.artist}</div>
        </div>
        <div style="display:flex; gap:0.4rem; align-items:center;">
          <button class="btn-pill btn-sm btn-queue-play" style="font-size:0.75rem; padding:0.3rem 0.65rem;" title="Play Now" type="button">Play</button>
          <button class="btn-remove-from-playlist btn-queue-remove" title="Remove from Queue" type="button">&times;</button>
        </div>
      `;

      item.querySelector('.btn-queue-play').addEventListener('click', async (e) => {
        e.stopPropagation();
        this.queueIndex = actualIdx;
        await this.loadTrack(track, true);
        this.renderQueueDrawer();
      });

      item.querySelector('.btn-queue-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeFromQueue(actualIdx);
      });

      this.queueUpcomingList.appendChild(item);
    });
  }

  // Sleep Timer
  openSleepTimerModal() {
    if (this.sleepTimerModal) {
      if (this.btnTurnOffSleepTimer) {
        this.btnTurnOffSleepTimer.style.display = this.sleepTimerTargetMs ? 'block' : 'none';
      }
      this.sleepTimerModal.classList.add('active');
    }
  }

  setSleepTimer(minutesOrEndOfTrack) {
    if (this.sleepTimerInterval) {
      clearInterval(this.sleepTimerInterval);
      this.sleepTimerInterval = null;
    }

    if (minutesOrEndOfTrack === 'end_of_track') {
      this.sleepTimerTargetMs = 'end_of_track';
      if (this.sleepTimerBadge) {
        this.sleepTimerBadge.textContent = '1S';
        this.sleepTimerBadge.style.display = 'block';
      }
      if (this.btnSleepTimer) this.btnSleepTimer.classList.add('active');
      this.showToast('Sleep timer set: End of Current Song 🌙');
      return;
    }

    const durationMs = minutesOrEndOfTrack * 60 * 1000;
    this.sleepTimerTargetMs = Date.now() + durationMs;
    if (this.btnSleepTimer) this.btnSleepTimer.classList.add('active');
    this.showToast(`Sleep timer set for ${minutesOrEndOfTrack} minutes 🌙`);

    this.updateSleepTimerBadge();
    this.sleepTimerInterval = setInterval(() => {
      this.updateSleepTimerBadge();
    }, 1000);
  }

  updateSleepTimerBadge() {
    if (!this.sleepTimerTargetMs || this.sleepTimerTargetMs === 'end_of_track') return;
    const remainingMs = this.sleepTimerTargetMs - Date.now();
    if (remainingMs <= 0) {
      this.triggerSleepTimerExpiry();
      return;
    }
    const remainingMin = Math.ceil(remainingMs / 60000);
    if (this.sleepTimerBadge) {
      this.sleepTimerBadge.textContent = `${remainingMin}m`;
      this.sleepTimerBadge.style.display = 'block';
    }
  }

  triggerSleepTimerExpiry() {
    this.clearSleepTimer();
    const startVol = this.player.volume;
    let fadeStep = 0;
    const fadeTimer = setInterval(() => {
      fadeStep++;
      const currentVol = Math.max(0, startVol * (1 - fadeStep / 8));
      this.player.setVolume(currentVol);
      if (fadeStep >= 8) {
        clearInterval(fadeTimer);
        this.player.pause();
        this.player.setVolume(startVol);
        this.showToast('Sleep timer expired. Playback paused 🌙');
      }
    }, 500);
  }

  clearSleepTimer() {
    if (this.sleepTimerInterval) {
      clearInterval(this.sleepTimerInterval);
      this.sleepTimerInterval = null;
    }
    this.sleepTimerTargetMs = null;
    if (this.sleepTimerBadge) this.sleepTimerBadge.style.display = 'none';
    if (this.btnSleepTimer) this.btnSleepTimer.classList.remove('active');
    this.showToast('Sleep timer turned OFF');
  }

  // ==========================================================================
  // Playlists System: CRUD, Views, Smart Playlists
  // ==========================================================================

  renderPlaylists() {
    this.playlists = Storage.getPlaylists();

    if (this.smartLikedSongsCount) {
      this.smartLikedSongsCount.textContent = `${this.favorites.length} songs`;
    }
    if (this.smartRecentSongsCount) {
      this.smartRecentSongsCount.textContent = `${this.recentlyPlayed.length} songs`;
    }

    if (!this.playlistsGrid) return;
    this.playlistsGrid.innerHTML = '';

    if (this.playlists.length === 0) {
      this.playlistsGrid.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 3rem 1.5rem; text-align: center; color: var(--color-text-dim); background: rgba(255,255,255,0.02); border-radius: 18px; border: 1px dashed rgba(255,255,255,0.08);">
          <div style="font-size: 1.1rem; font-weight: 700; color: #fff; margin-bottom: 0.4rem;">No Custom Playlists Yet</div>
          <p style="font-size: 0.85rem; margin-bottom: 1.2rem;">Create playlists to curate your favorite Ethiopian songs, vibe sessions, or Tizita classics.</p>
          <button class="btn-primary" id="btnEmptyCreatePlaylist" style="display:inline-flex; align-items:center; gap:0.5rem; font-size:0.85rem; padding:0.6rem 1.25rem;">
            <span>Create Your First Playlist</span>
          </button>
        </div>
      `;
      const emptyBtn = this.playlistsGrid.querySelector('#btnEmptyCreatePlaylist');
      if (emptyBtn) emptyBtn.addEventListener('click', () => this.openCreatePlaylistModal());
      return;
    }

    this.playlists.forEach(pl => {
      const songCount = (pl.trackIds || []).length;
      const card = document.createElement('div');
      card.className = 'playlist-card';
      card.innerHTML = `
        <div class="playlist-card-art" style="background: ${pl.gradient || 'linear-gradient(135deg, #e5b95a, #d97706)'};">
          ${pl.cover ? `<img src="${pl.cover}" class="playlist-card-img" alt="${pl.title}" crossorigin="anonymous" onerror="this.style.display='none'">` : `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="opacity:0.85;"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`}
          <button class="playlist-card-hover-play" title="Play Playlist" type="button">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
          </button>
        </div>
        <div class="playlist-card-title" title="${pl.title}">${pl.title}</div>
        <div class="playlist-card-sub">${songCount} ${songCount === 1 ? 'song' : 'songs'}</div>
      `;

      card.addEventListener('click', () => {
        this.openPlaylistDetail(pl.id);
      });

      const playBtn = card.querySelector('.playlist-card-hover-play');
      if (playBtn) {
        playBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.activePlaylist = pl;
          this.playCurrentPlaylist(false);
        });
      }

      this.playlistsGrid.appendChild(card);
    });
  }

  openCreatePlaylistModal() {
    if (this.inputPlaylistTitle) this.inputPlaylistTitle.value = '';
    if (this.inputPlaylistDesc) this.inputPlaylistDesc.value = '';
    if (this.createPlaylistModal) this.createPlaylistModal.classList.add('active');
  }

  handleCreatePlaylist(e) {
    e.preventDefault();
    const title = this.inputPlaylistTitle ? this.inputPlaylistTitle.value.trim() : '';
    if (!title) return;
    const desc = this.inputPlaylistDesc ? this.inputPlaylistDesc.value.trim() : '';
    const newPl = Storage.createPlaylist(title, desc);
    this.playlists = Storage.getPlaylists();
    if (this.createPlaylistModal) this.createPlaylistModal.classList.remove('active');
    this.showToast(`Playlist "${newPl.title}" created! 🎉`);
    this.renderPlaylists();
    this.openPlaylistDetail(newPl.id);
  }

  openSmartPlaylist(type) {
    const all = [...this.publicTracks, ...this.tracks];
    let tracks = [];
    let title = '';
    let desc = '';
    let grad = '';

    if (type === 'liked') {
      title = 'Liked Songs';
      desc = 'All your favorited songs in one place.';
      grad = 'linear-gradient(135deg, #f43f5e, #a855f7)';
      tracks = this.favorites.map(id => all.find(t => t.id === id)).filter(Boolean);
    } else {
      title = 'Recently Played';
      desc = 'Your recent listening history and tracks.';
      grad = 'linear-gradient(135deg, #3b82f6, #14b8a6)';
      tracks = this.recentlyPlayed.map(id => all.find(t => t.id === id)).filter(Boolean);
    }

    const smartPl = {
      id: `smart_${type}`,
      isSmart: true,
      title: title,
      description: desc,
      gradient: grad,
      trackIds: tracks.map(t => t.id)
    };

    this.activePlaylist = smartPl;
    this.renderSinglePlaylistView(smartPl, tracks);
  }

  openPlaylistDetail(playlistId) {
    const pl = Storage.getPlaylist(playlistId);
    if (!pl) return;
    this.activePlaylist = pl;

    const all = [...this.publicTracks, ...this.tracks];
    const tracks = (pl.trackIds || []).map(id => all.find(t => t.id === id)).filter(Boolean);
    this.renderSinglePlaylistView(pl, tracks);
  }

  renderSinglePlaylistView(playlist, tracks = null) {
    if (!this.singlePlaylistView) return;
    if (this.playlistsContainer) this.playlistsContainer.style.display = 'none';
    this.singlePlaylistView.style.display = 'flex';

    const all = [...this.publicTracks, ...this.tracks];
    const playlistTracks = tracks || (playlist.trackIds || []).map(id => all.find(t => t.id === id)).filter(Boolean);

    // Banner Header
    if (this.playlistBannerTitle) this.playlistBannerTitle.textContent = playlist.title;
    if (this.playlistBannerDesc) this.playlistBannerDesc.textContent = playlist.description || 'Custom playlist on ELM';
    if (this.playlistBannerArt) {
      this.playlistBannerArt.style.background = playlist.gradient || 'linear-gradient(135deg, #e5b95a, #d97706)';
      if (playlist.cover) {
        this.playlistBannerArt.innerHTML = `<img src="${playlist.cover}" style="width:100%; height:100%; object-fit:cover; border-radius:16px;" alt="${playlist.title}">`;
      } else {
        this.playlistBannerArt.innerHTML = `<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
      }
    }

    const totalDurSec = playlistTracks.reduce((acc, t) => acc + (this.getTrackDuration(t) || 0), 0);
    const totalMin = Math.round(totalDurSec / 60);
    if (this.playlistBannerMeta) {
      this.playlistBannerMeta.textContent = `${playlistTracks.length} songs ${totalMin > 0 ? `• ~${totalMin} min` : ''}`;
    }

    if (this.btnPlaylistDelete) {
      this.btnPlaylistDelete.style.display = playlist.isSmart ? 'none' : 'inline-flex';
    }
    if (this.btnPlaylistAddTracks) {
      this.btnPlaylistAddTracks.style.display = playlist.isSmart ? 'none' : 'inline-flex';
    }

    if (!this.playlistTracksList) return;
    this.playlistTracksList.innerHTML = '';

    if (playlistTracks.length === 0) {
      this.playlistTracksList.innerHTML = `
        <div style="text-align:center; padding:3rem 1.5rem; color:var(--color-text-dim); background:rgba(255,255,255,0.02); border-radius:16px; border:1px dashed rgba(255,255,255,0.08);">
          <p style="font-size:0.9rem; margin-bottom:1rem;">This playlist is currently empty.</p>
          ${!playlist.isSmart ? `<button class="btn-primary" id="btnEmptyAddSongs" style="font-size:0.85rem; padding:0.55rem 1.2rem;">Add Songs to Playlist</button>` : ''}
        </div>
      `;
      const addBtn = this.playlistTracksList.querySelector('#btnEmptyAddSongs');
      if (addBtn) addBtn.addEventListener('click', () => this.openAddTracksToPlaylistPicker());
      return;
    }

    playlistTracks.forEach((track, idx) => {
      const isCurrent = this.currentTrack && this.currentTrack.id === track.id;
      const row = document.createElement('div');
      row.className = `playlist-track-row ${isCurrent ? 'playing' : ''}`;
      const trackDur = this.getTrackDuration(track);
      row.innerHTML = `
        <span class="playlist-track-idx">${idx + 1}</span>
        <img src="${track.cover || 'assets/weleta_cover.jpg'}" alt="${track.title}" class="playlist-track-thumb" crossorigin="anonymous" onerror="this.src='assets/weleta_cover.jpg'">
        <div style="flex:1; min-width:0;">
          <div class="playlist-track-title">${track.title}</div>
          <div class="playlist-track-artist">${track.artist}</div>
        </div>
        <span class="playlist-track-duration">${LyricsParser.formatTime(trackDur, '--:--')}</span>
        <button class="btn-pill btn-sm btn-play-row" style="padding:0.3rem 0.65rem; font-size:0.75rem;" type="button">Play</button>
        ${!playlist.isSmart ? `<button class="btn-remove-from-playlist btn-remove-track-from-pl" title="Remove from playlist" type="button">&times;</button>` : ''}
      `;

      row.querySelector('.btn-play-row').addEventListener('click', async (e) => {
        e.stopPropagation();
        this.setQueue(playlistTracks, idx);
        await this.loadTrack(track, true);
        this.renderSinglePlaylistView(playlist, playlistTracks);
      });

      row.addEventListener('click', async (e) => {
        if (e.target.closest('button')) return;
        this.setQueue(playlistTracks, idx);
        await this.loadTrack(track, true);
        this.renderSinglePlaylistView(playlist, playlistTracks);
      });

      const removeBtn = row.querySelector('.btn-remove-track-from-pl');
      if (removeBtn) {
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.removeTrackFromPlaylist(playlist.id, track.id);
        });
      }

      this.playlistTracksList.appendChild(row);
    });
  }

  playCurrentPlaylist(shuffle = false) {
    if (!this.activePlaylist) return;
    const all = [...this.publicTracks, ...this.tracks];
    const tracks = (this.activePlaylist.trackIds || []).map(id => all.find(t => t.id === id)).filter(Boolean);
    if (tracks.length === 0) {
      this.showToast('Playlist is empty.');
      return;
    }

    if (shuffle) {
      this.shuffleMode = true;
      Storage.setShuffleState(true);
      this.initPlaybackModeUI();
    }

    this.setQueue(tracks, 0);
    this.loadTrack(this.queue[0], true);
    this.showToast(`Playing "${this.activePlaylist.title}" 🎶`);
  }

  deleteCurrentPlaylist() {
    if (!this.activePlaylist || this.activePlaylist.isSmart) return;
    if (confirm(`Are you sure you want to delete "${this.activePlaylist.title}"?`)) {
      Storage.deletePlaylist(this.activePlaylist.id);
      this.playlists = Storage.getPlaylists();
      this.activePlaylist = null;
      this.showToast('Playlist deleted');
      if (this.singlePlaylistView) this.singlePlaylistView.style.display = 'none';
      if (this.playlistsContainer) this.playlistsContainer.style.display = 'flex';
      this.renderPlaylists();
    }
  }

  removeTrackFromPlaylist(playlistId, trackId) {
    Storage.removeTrackFromPlaylist(playlistId, trackId);
    this.playlists = Storage.getPlaylists();
    this.showToast('Song removed from playlist');
    this.openPlaylistDetail(playlistId);
  }

  // Add to Playlist Picker Dialog
  openAddToPlaylistModal(track) {
    this.currentPendingPlaylistTrack = track || this.currentTrack;
    if (!this.currentPendingPlaylistTrack) {
      this.showToast('Select or play a song first');
      return;
    }

    if (this.addToPlaylistCover) {
      this.addToPlaylistCover.src = this.currentPendingPlaylistTrack.cover || 'assets/weleta_cover.jpg';
    }
    if (this.addToPlaylistTitle) {
      this.addToPlaylistTitle.textContent = this.currentPendingPlaylistTrack.title || 'Untitled';
    }
    if (this.addToPlaylistArtist) {
      this.addToPlaylistArtist.textContent = this.currentPendingPlaylistTrack.artist || 'Unknown Artist';
    }

    this.renderAddToPlaylistChoices();
    if (this.addToPlaylistModal) this.addToPlaylistModal.classList.add('active');
  }

  renderAddToPlaylistChoices() {
    if (!this.addToPlaylistChoicesList) return;
    this.addToPlaylistChoicesList.innerHTML = '';
    this.playlists = Storage.getPlaylists();

    if (this.playlists.length === 0) {
      this.addToPlaylistChoicesList.innerHTML = `
        <div style="text-align:center; padding:1.5rem; color:var(--color-text-dim); font-size:0.82rem;">
          No custom playlists yet. Click "Create New Playlist" above to start!
        </div>
      `;
      return;
    }

    const trackId = this.currentPendingPlaylistTrack ? this.currentPendingPlaylistTrack.id : null;

    this.playlists.forEach(pl => {
      const isAlreadyIn = trackId && Storage.isTrackInPlaylist(pl.id, trackId);
      const row = document.createElement('div');
      row.className = `playlist-choice-row ${isAlreadyIn ? 'in-playlist' : ''}`;
      row.innerHTML = `
        <div style="display:flex; align-items:center; gap:0.65rem;">
          <div style="width:12px; height:12px; border-radius:50%; background:${pl.gradient || '#e5b95a'}; flex-shrink:0;"></div>
          <div>
            <div style="font-weight:600; font-size:0.88rem; color:#fff;">${pl.title}</div>
            <div style="font-size:0.72rem; color:var(--color-text-dim);">${(pl.trackIds || []).length} songs</div>
          </div>
        </div>
        <button class="btn-pill btn-sm" style="font-size:0.75rem; padding:0.25rem 0.65rem; border-color:${isAlreadyIn ? 'var(--color-gold)' : 'rgba(255,255,255,0.2)'}; color:${isAlreadyIn ? 'var(--color-gold)' : '#fff'};" type="button">
          ${isAlreadyIn ? '✓ In Playlist' : '+ Add'}
        </button>
      `;

      row.addEventListener('click', () => {
        if (isAlreadyIn) {
          Storage.removeTrackFromPlaylist(pl.id, trackId);
          this.showToast(`Removed from "${pl.title}"`);
        } else {
          Storage.addTrackToPlaylist(pl.id, trackId);
          this.showToast(`Added to "${pl.title}" ✨`);
        }
        this.renderAddToPlaylistChoices();
        if (this.activePlaylist && this.activePlaylist.id === pl.id) {
          this.openPlaylistDetail(pl.id);
        }
      });

      this.addToPlaylistChoicesList.appendChild(row);
    });
  }

  // Catalog Song Picker for Single Playlist View
  openAddTracksToPlaylistPicker() {
    if (!this.activePlaylist) return;
    if (this.inputPlaylistSongSearch) this.inputPlaylistSongSearch.value = '';
    this.renderAddTracksPickerList('');
    if (this.addTracksToPlaylistPickerModal) this.addTracksToPlaylistPickerModal.classList.add('active');
  }

  renderAddTracksPickerList(filterQuery = '') {
    if (!this.playlistSongPickerList || !this.activePlaylist) return;
    this.playlistSongPickerList.innerHTML = '';

    const all = [...this.publicTracks, ...this.tracks];
    let filtered = all;
    if (filterQuery) {
      filtered = all.filter(t =>
        (t.title && t.title.toLowerCase().includes(filterQuery)) ||
        (t.artist && t.artist.toLowerCase().includes(filterQuery))
      );
    }

    if (filtered.length === 0) {
      this.playlistSongPickerList.innerHTML = `
        <div style="text-align:center; padding:2rem; color:var(--color-text-dim); font-size:0.85rem;">
          No matching songs found.
        </div>
      `;
      return;
    }

    filtered.forEach(track => {
      const isAlreadyIn = Storage.isTrackInPlaylist(this.activePlaylist.id, track.id);
      const row = document.createElement('div');
      row.className = 'playlist-choice-row';
      row.innerHTML = `
        <div style="display:flex; align-items:center; gap:0.75rem; flex:1; min-width:0;">
          <img src="${track.cover || 'assets/weleta_cover.jpg'}" alt="${track.title}" style="width:36px; height:36px; border-radius:6px; object-fit:cover;">
          <div style="overflow:hidden;">
            <div style="font-weight:600; font-size:0.88rem; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${track.title}</div>
            <div style="font-size:0.72rem; color:var(--color-text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${track.artist}</div>
          </div>
        </div>
        <button class="btn-pill btn-sm" style="font-size:0.75rem; padding:0.3rem 0.75rem; ${isAlreadyIn ? 'color:var(--color-gold); border-color:var(--color-gold);' : ''}" type="button">
          ${isAlreadyIn ? '✓ Added' : '+ Add'}
        </button>
      `;

      row.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        if (isAlreadyIn) {
          Storage.removeTrackFromPlaylist(this.activePlaylist.id, track.id);
          this.showToast(`Removed "${track.title}"`);
        } else {
          Storage.addTrackToPlaylist(this.activePlaylist.id, track.id);
          this.showToast(`Added "${track.title}" to playlist!`);
        }
        this.renderAddTracksPickerList(this.inputPlaylistSongSearch ? this.inputPlaylistSongSearch.value.trim().toLowerCase() : '');
        this.openPlaylistDetail(this.activePlaylist.id);
      });

      this.playlistSongPickerList.appendChild(row);
    });
  }

  async shareRoomInvite(buttonEl, labelEl) {
    if (!this.activeRoom) return;
    const roomCode = this.activeRoom.roomCode;
    const url = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
    const trackTitle = (this.activeRoom.currentTrack && this.activeRoom.currentTrack.title) 
      ? this.activeRoom.currentTrack.title 
      : 'Ethiopian Music';
    
    const shareData = {
      title: `Listen with me on ELM (${roomCode})`,
      text: `🎵 Join my live Ethiopian music session on ELM! We're playing "${trackTitle}". Room: ${roomCode}`,
      url: url
    };

    // 1. Try native Web Share API (mobile devices, Safari, Chrome)
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        if (labelEl) {
          const origText = labelEl.textContent;
          labelEl.textContent = 'Shared!';
          setTimeout(() => { if (labelEl) labelEl.textContent = origText; }, 2000);
        }
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // User cancelled share dialog
      }
    }

    // 2. Clipboard fallback if Web Share is unavailable or declined
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        const origText = labelEl ? labelEl.textContent : 'Share';
        if (labelEl) labelEl.textContent = 'Link Copied!';
        if (this.showToast) this.showToast('Room link copied to clipboard!');
        setTimeout(() => {
          if (labelEl) labelEl.textContent = origText;
        }, 2200);
        return;
      } catch (e) {
        prompt('Copy Room Invite Link:', url);
      }
    } else {
      prompt('Copy Room Invite Link:', url);
    }
  }

  // Backwards compatibility alias
  copyRoomInviteLink(buttonEl, labelEl) {
    return this.shareRoomInvite(buttonEl, labelEl);
  }
}

// Instantiate on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.lyricsApp = new LyricsApp();
});
