import { LyricsParser } from './lyrics-parser.js';

/**
 * Audio Engine: Handles HTML5 Audio playback + Web Audio API synthesizer fallback
 */
export class AudioPlayer {
  constructor() {
    this.audioElement = new Audio();
    this.audioElement.preload = 'metadata';
    this.audioElement.preservesPitch = true;
    this.audioElement.mozPreservesPitch = true;
    this.audioElement.webkitPreservesPitch = true;
    
    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;
    this.volume = 0.8;
    this.playbackRate = 1.0;
    this.syncRateMultiplier = 1.0;
    this.isSynthetic = false;
    this.hasAudioSource = false;
    this.audioUrl = null;

    // Callbacks
    this.onTimeUpdate = null;
    this.onDurationChange = null;
    this.onBufferUpdate = null;
    this.onStateChange = null;
    this.onEnded = null;
    this.onPlaying = null;
    this.onSeeked = null;
    this.onWaiting = null;
    this.onError = null;
    this._isBlobUrl = false;
    this._corsFallbackTried = false;
    this._wantedPlayOnLoad = false;

    // Web Audio Synthesizer state
    this.audioCtx = null;
    this.synthInterval = null;
    this.synthStartTime = 0;
    this.synthPauseOffset = 0;
    this._rafId = null;
    this._rafIntervalMs = 50; // ~20 FPS UI/lyric updates (plenty smooth, 3x less CPU than 60fps)
    this._lastRafEmitMs = 0;

    this.initAudioListeners();
  }

  setTickIntervalMs(ms) {
    this._rafIntervalMs = Math.max(16, Math.min(250, Number(ms) || 50));
  }

  initAudioListeners() {
    // Keep timeupdate as fallback, but primary high-resolution updates are driven at 60fps via RAF
    this.audioElement.addEventListener('timeupdate', () => {
      if (!this.isSynthetic) {
        this.currentTime = this.audioElement.currentTime;
        if (this.audioElement.duration && isFinite(this.audioElement.duration) && this.audioElement.duration > 0) {
          this.duration = this.audioElement.duration;
        }
        if (this.onTimeUpdate) {
          this.onTimeUpdate(this.currentTime, this.duration);
        }
      }
    });

    this.audioElement.addEventListener('play', () => {
      this.isPlaying = true;
      this._startRafTicker();
      if (this.onStateChange) this.onStateChange('playing');
    });

    this.audioElement.addEventListener('playing', () => {
      if (this.onPlaying) this.onPlaying();
    });

    this.audioElement.addEventListener('seeked', () => {
      if (this.onSeeked) this.onSeeked();
    });

    this.audioElement.addEventListener('waiting', () => {
      if (this.onWaiting) this.onWaiting();
    });

    this.audioElement.addEventListener('pause', () => {
      this.isPlaying = false;
      this._stopRafTicker();
      if (this.onStateChange) this.onStateChange('paused');
    });

    this.audioElement.addEventListener('ended', () => {
      this.isPlaying = false;
      this._stopRafTicker();
      if (this.onEnded) this.onEnded();
      if (this.onStateChange) this.onStateChange('ended');
    });

    const handleDurationMeta = () => {
      if (!this.isSynthetic && this.audioElement.duration && isFinite(this.audioElement.duration) && this.audioElement.duration > 0) {
        this.duration = this.audioElement.duration;
        if (this.onTimeUpdate) {
          this.onTimeUpdate(this.currentTime, this.duration);
        }
        if (this.onDurationChange) {
          this.onDurationChange(this.duration);
        }
      }
    };

    this.audioElement.addEventListener('loadedmetadata', handleDurationMeta);
    this.audioElement.addEventListener('durationchange', handleDurationMeta);
    const emitBuffered = () => {
      if (this.isSynthetic || !this.onBufferUpdate) return;
      const dur = (this.audioElement.duration && isFinite(this.audioElement.duration) && this.audioElement.duration > 0)
        ? this.audioElement.duration
        : this.duration;
      if (!dur || dur <= 0 || !this.audioElement.buffered || this.audioElement.buffered.length === 0) {
        this.onBufferUpdate(0);
        return;
      }
      const end = this.audioElement.buffered.end(this.audioElement.buffered.length - 1);
      this.onBufferUpdate(Math.min(100, Math.max(0, (end / dur) * 100)));
    };
    this.audioElement.addEventListener('progress', emitBuffered);
    this.audioElement.addEventListener('canplay', emitBuffered);
    this.audioElement.addEventListener('error', () => {
      if (this.isSynthetic || !this.audioElement.getAttribute('src')) return;
      if (this.audioElement.crossOrigin && !this._corsFallbackTried && this.audioUrl && !this._isBlobUrl) {
        this._corsFallbackTried = true;
        const shouldPlay = this._wantedPlayOnLoad;
        this.audioElement.removeAttribute('crossOrigin');
        this.audioElement.src = this.audioUrl;
        this.audioElement.load();
        if (shouldPlay) {
          this.audioElement.play().catch(() => {});
        }
        return;
      }
      this.isPlaying = false;
      this._wantedPlayOnLoad = false;
      this._stopRafTicker();
      if (this.onStateChange) this.onStateChange('paused');
      if (this.onError) {
        const code = this.audioElement.error ? this.audioElement.error.code : 0;
        const codeMessages = {
          1: 'Audio loading was aborted.',
          2: 'Network error or blocked connection while streaming audio.',
          3: 'Audio decoding failed or stream was interrupted.',
          4: 'Audio stream unavailable or blocked by browser privacy rules.'
        };
        this.onError(codeMessages[code] || 'Unable to stream or decode this audio track.');
      }
    });
  }

  initWebAudio() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  _revokeBlobUrl() {
    if (this._isBlobUrl && this.audioUrl) {
      try { URL.revokeObjectURL(this.audioUrl); } catch (e) {}
    }
    this._isBlobUrl = false;
  }

  updateMediaSession(track, handlers = {}) {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !track) return;
    try {
      const artworkUrl = track.cover && !track.cover.startsWith('blob:') ? track.cover : 'assets/weleta_cover.jpg';
      if (typeof MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title || 'Untitled Track',
          artist: track.artist || 'Unknown Artist',
          album: track.album || 'ELM - Ethio Lyrics Media',
          artwork: [{ src: artworkUrl, sizes: '512x512', type: 'image/jpeg' }]
        });
      }
      if (handlers.onPlay) navigator.mediaSession.setActionHandler('play', handlers.onPlay);
      if (handlers.onPause) navigator.mediaSession.setActionHandler('pause', handlers.onPause);
      if (handlers.onPrevioustrack) navigator.mediaSession.setActionHandler('previoustrack', handlers.onPrevioustrack);
      if (handlers.onNexttrack) navigator.mediaSession.setActionHandler('nexttrack', handlers.onNexttrack);
    } catch (e) {
      // MediaSession not supported in all contexts
    }
  }

  _normalizeStreamUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (!trimmed) return '';
    try {
      return encodeURI(decodeURI(trimmed));
    } catch (e) {
      return encodeURI(trimmed);
    }
  }

  loadTrack(track) {
    this.pause();
    this.currentTime = 0;
    if (this.onBufferUpdate) this.onBufferUpdate(0);

    // Resolve real duration: from track.duration (if valid and not default 180), or LRC timestamp estimate, or 0
    let initialDuration = 0;
    if (track.duration && isFinite(track.duration) && track.duration > 0 && track.duration !== 180) {
      initialDuration = track.duration;
    } else if (track.lrc) {
      initialDuration = LyricsParser.estimateDurationFromLrc(track.lrc);
    } else if (track.duration && isFinite(track.duration) && track.duration > 0) {
      initialDuration = track.duration;
    }
    this.duration = initialDuration;

    if (track.audioBlob) {
      this.loadAudioFile(track.audioBlob);
    } else if (track._audioFile) {
      this.loadAudioFile(track._audioFile);
    } else if (track.audioUrl && track.audioUrl.trim()) {
      this._revokeBlobUrl();
      this.isSynthetic = false;
      this.hasAudioSource = true;
      this._corsFallbackTried = false;
      this._wantedPlayOnLoad = false;
      const streamUrl = this._normalizeStreamUrl(track.audioUrl);
      this.audioUrl = streamUrl;
      const isProdPagesOrigin = typeof window !== 'undefined' && window.location && window.location.origin === 'https://ethio-lyrics-player.pages.dev';
      if (isProdPagesOrigin && streamUrl.includes('.r2.dev/')) {
        this.audioElement.crossOrigin = 'anonymous';
      } else {
        this.audioElement.removeAttribute('crossOrigin');
      }
      // Progressive HTTP Range streaming: fetch only metadata until playback starts
      this.audioElement.preload = 'metadata';
      this.audioElement.src = streamUrl;
      this.audioElement.load();
      this.audioElement.volume = this.volume;
      this.audioElement.playbackRate = this.getEffectivePlaybackRate();
    } else if (track.isDemoSynth === true) {
      this._revokeBlobUrl();
      this.isSynthetic = true;
      this.hasAudioSource = true;
      this.audioElement.removeAttribute('src');
      this.audioElement.load();
      this.audioUrl = null;
    } else {
      this._revokeBlobUrl();
      this.isSynthetic = false;
      this.hasAudioSource = false;
      this.audioElement.removeAttribute('src');
      this.audioElement.load();
      this.audioUrl = null;
    }

    if (this.onTimeUpdate) {
      this.onTimeUpdate(0, this.duration);
    }
  }

  loadAudioFile(file) {
    this._revokeBlobUrl();
    const url = URL.createObjectURL(file);
    this.audioUrl = url;
    this._isBlobUrl = true;
    this.isSynthetic = false;
    this.hasAudioSource = true;
    this._corsFallbackTried = false;
    this._wantedPlayOnLoad = false;
    this.audioElement.removeAttribute('crossOrigin');
    this.audioElement.preload = 'auto';
    this.audioElement.src = url;
    this.audioElement.load();
    this.audioElement.volume = this.volume;
    this.audioElement.playbackRate = this.getEffectivePlaybackRate();
    this.seek(0);
    if (this.onBufferUpdate) this.onBufferUpdate(100);
  }

  play() {
    if (this.isSynthetic) {
      this.initWebAudio();
      this.isPlaying = true;
      this.synthStartTime = performance.now() - (this.currentTime * 1000);
      
      this.stopSyntheticTicker();
      // 100ms ticker (10fps) gives smooth scrubber and lyrics without CPU lag
      this.synthInterval = setInterval(() => {
        const elapsed = (performance.now() - this.synthStartTime) / 1000;
        this.currentTime = elapsed;

        // Trigger gentle musical notes periodically (Ethio Tizita pentatonic scale: C, D, E, G, A)
        this.playSyntheticChordNote(this.currentTime);

        if (this.currentTime >= this.duration) {
          this.pause();
          this.seek(0);
          if (this.onEnded) this.onEnded();
          return;
        }

        if (this.onTimeUpdate) {
          this.onTimeUpdate(this.currentTime, this.duration);
        }
      }, 100);

      if (this.onPlaying) this.onPlaying();
      if (this.onStateChange) this.onStateChange('playing');
      return Promise.resolve(true);
    } else {
      if (!this.hasAudioSource || !this.audioUrl) {
        if (this.onError) {
          this.onError('No audio stream is available for this track yet.');
        }
        return Promise.resolve(false);
      }
      // Switch to progressive buffering as soon as playback is requested
      this._wantedPlayOnLoad = true;
      this.audioElement.preload = 'auto';
      this.audioElement.volume = this.volume;
      this.audioElement.playbackRate = this.getEffectivePlaybackRate();
      return this.audioElement.play().then(() => {
        this.isPlaying = true;
        this._startRafTicker();
        if (this.onStateChange) this.onStateChange('playing');
        return true;
      }).catch(e => {
        console.warn('Audio play prevented:', e);
        if (e && e.name !== 'NotAllowedError' && this.onError) {
          this.onError('Could not start audio stream. Check connection and try again.');
        }
        return false;
      });
    }
  }

  pause() {
    this.isPlaying = false;
    this._stopRafTicker();
    if (this.isSynthetic) {
      this.stopSyntheticTicker();
      if (this.onStateChange) this.onStateChange('paused');
    } else {
      this.audioElement.pause();
      if (this.onStateChange) this.onStateChange('paused');
    }
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  seek(seconds) {
    this.currentTime = Math.max(0, Math.min(seconds, this.duration));
    if (this.isSynthetic) {
      this.synthStartTime = performance.now() - (this.currentTime * 1000);
      if (this.onTimeUpdate) {
        this.onTimeUpdate(this.currentTime, this.duration);
      }
      if (this.onSeeked) {
        this.onSeeked();
      }
    } else {
      this.audioElement.currentTime = this.currentTime;
      if (this.onTimeUpdate) {
        this.onTimeUpdate(this.currentTime, this.duration);
      }
    }
  }

  _startRafTicker() {
    this._stopRafTicker();
    this._lastRafEmitMs = 0;
    const tick = (now) => {
      if (!this.isPlaying) return;
      if (!this.isSynthetic && this.audioElement && !this.audioElement.paused) {
        if (!this._lastRafEmitMs || (now - this._lastRafEmitMs) >= this._rafIntervalMs) {
          this._lastRafEmitMs = now;
          this.currentTime = this.audioElement.currentTime;
          if (this.audioElement.duration && isFinite(this.audioElement.duration) && this.audioElement.duration > 0) {
            this.duration = this.audioElement.duration;
          }
          if (this.onTimeUpdate) {
            this.onTimeUpdate(this.currentTime, this.duration);
          }
        }
      }
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopRafTicker() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, val));
    this.audioElement.volume = this.volume;
  }

  getEffectivePlaybackRate() {
    return Math.max(0.25, Math.min(4.0, (this.playbackRate || 1.0) * (this.syncRateMultiplier || 1.0)));
  }

  setPlaybackRate(rate) {
    this.playbackRate = rate;
    this.audioElement.playbackRate = this.getEffectivePlaybackRate();
  }

  setSyncRateMultiplier(mult) {
    this.syncRateMultiplier = mult || 1.0;
    this.audioElement.playbackRate = this.getEffectivePlaybackRate();
  }

  stopSyntheticTicker() {
    if (this.synthInterval) {
      clearInterval(this.synthInterval);
      this.synthInterval = null;
    }
  }

  /**
   * Generates a warm, ambient Ethio-pentatonic instrumental accompaniment
   * using Web Audio API oscillators and gain envelopes
   */
  playSyntheticChordNote(time) {
    if (!this.audioCtx || this.volume <= 0.01) return;

    const beat = Math.floor(time * 2); // 120 bpm eighth notes
    if (beat === this._lastBeat) return;
    this._lastBeat = beat;

    // Tizita Major / Pentatonic scale notes: C4, D4, E4, G4, A4, C5
    const pentatonicFreqs = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25];
    const bassFreqs = [65.41, 73.42, 82.41, 98.00];

    const noteIdx = (beat % 4 === 0) ? (beat / 4) % pentatonicFreqs.length : (beat * 2) % pentatonicFreqs.length;
    const freq = pentatonicFreqs[noteIdx % pentatonicFreqs.length];

    try {
      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      // Instrument tone: warm soft sine/triangle hybrid
      osc.type = (beat % 2 === 0) ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, now);

      const noteVol = (beat % 4 === 0 ? 0.08 : 0.04) * this.volume;
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(noteVol, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start(now);
      osc.stop(now + 0.5);

      // Bass note on downbeats
      if (beat % 8 === 0) {
        const bassOsc = this.audioCtx.createOscillator();
        const bassGain = this.audioCtx.createGain();
        bassOsc.type = 'sine';
        bassOsc.frequency.setValueAtTime(bassFreqs[(beat / 8) % bassFreqs.length], now);
        bassGain.gain.setValueAtTime(0.12 * this.volume, now);
        bassGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
        bassOsc.connect(bassGain);
        bassGain.connect(this.audioCtx.destination);
        bassOsc.start(now);
        bassOsc.stop(now + 1.0);
      }
    } catch (e) {
      // AudioContext state error safeguard
    }
  }
}
