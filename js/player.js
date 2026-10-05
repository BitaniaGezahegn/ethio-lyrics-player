import { LyricsParser } from './lyrics-parser.js';

/**
 * Audio Engine: Handles HTML5 Audio playback + Web Audio API synthesizer fallback
 */
export class AudioPlayer {
  constructor() {
    this.audioElement = new Audio();
    this.audioElement.preload = 'auto';
    this.audioElement.preservesPitch = true;
    this.audioElement.mozPreservesPitch = true;
    this.audioElement.webkitPreservesPitch = true;
    
    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;
    this.volume = 0.8;
    this.playbackRate = 1.0;
    this.isSynthetic = true; // Use synth if no external audio file loaded
    this.audioUrl = null;

    // Callbacks
    this.onTimeUpdate = null;
    this.onDurationChange = null;
    this.onStateChange = null;
    this.onEnded = null;

    // Web Audio Synthesizer state
    this.audioCtx = null;
    this.synthInterval = null;
    this.synthStartTime = 0;
    this.synthPauseOffset = 0;
    this._rafId = null;

    this.initAudioListeners();
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

  loadTrack(track) {
    this.pause();
    this.currentTime = 0;

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
    } else if (track.audioUrl) {
      this.isSynthetic = false;
      this.audioElement.src = track.audioUrl;
      this.audioUrl = track.audioUrl;
    } else {
      this.isSynthetic = true;
      this.audioElement.removeAttribute('src');
      this.audioUrl = null;
    }

    if (this.onTimeUpdate) {
      this.onTimeUpdate(0, this.duration);
    }
  }

  loadAudioFile(file) {
    if (this.audioUrl) {
      try { URL.revokeObjectURL(this.audioUrl); } catch (e) {}
    }
    const url = URL.createObjectURL(file);
    this.audioUrl = url;
    this.isSynthetic = false;
    this.audioElement.src = url;
    this.audioElement.load();
    this.audioElement.volume = this.volume;
    this.audioElement.playbackRate = this.playbackRate;
    this.seek(0);
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

      if (this.onStateChange) this.onStateChange('playing');
    } else {
      this.audioElement.volume = this.volume;
      this.audioElement.playbackRate = this.playbackRate;
      this.audioElement.play().then(() => {
        this.isPlaying = true;
        this._startRafTicker();
        if (this.onStateChange) this.onStateChange('playing');
      }).catch(e => console.warn('Audio play prevented:', e));
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
    } else {
      this.audioElement.currentTime = this.currentTime;
      if (this.onTimeUpdate) {
        this.onTimeUpdate(this.currentTime, this.duration);
      }
    }
  }

  _startRafTicker() {
    this._stopRafTicker();
    const tick = () => {
      if (!this.isPlaying) return;
      if (!this.isSynthetic && this.audioElement && !this.audioElement.paused) {
        this.currentTime = this.audioElement.currentTime;
        if (this.audioElement.duration && isFinite(this.audioElement.duration) && this.audioElement.duration > 0) {
          this.duration = this.audioElement.duration;
        }
        if (this.onTimeUpdate) {
          this.onTimeUpdate(this.currentTime, this.duration);
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

  setPlaybackRate(rate) {
    this.playbackRate = rate;
    this.audioElement.playbackRate = rate;
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
