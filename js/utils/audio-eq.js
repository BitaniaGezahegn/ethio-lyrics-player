/**
 * CORS-safe 5-band Web Audio Equalizer & frequency energy reader.
 * Attaches ONLY to blob: URLs or streams verified with crossOrigin="anonymous",
 * ensuring non-CORS third-party streams are never muted by Web Audio origin rules.
 */
export const EQ_PRESETS = {
  flat: { label: 'Flat (Original)', gains: [0, 0, 0, 0, 0] },
  tizita: { label: 'Warm Zema / Begena', gains: [2.5, 1.5, 2.5, 1.0, -0.5] },
  vocal: { label: 'Choir & Lyrics', gains: [-2, 1, 4, 3, 1] },
  bass: { label: 'Deep Warmth', gains: [5.5, 3.0, 0, 0, 1.0] },
  treble: { label: 'Crisp Acoustic', gains: [0, 0, 1.5, 3.0, 4.5] }
};

const BAND_FREQUENCIES = [60, 230, 910, 3600, 14000];

export class AudioEqualizer {
  constructor() {
    this.audioCtx = null;
    this.sourceNode = null;
    this.filters = [];
    this.analyser = null;
    this._freqData = null;
    this.preset = 'flat';
    this.attachedElement = null;
    this.corsSafeAttached = false;
  }

  loadSavedPreset() {
    try {
      const saved = localStorage.getItem('ethio_audio_eq_preset');
      if (saved && EQ_PRESETS[saved]) this.preset = saved;
    } catch { }
    return this.preset;
  }

  setPreset(presetId, persist = true) {
    const key = EQ_PRESETS[presetId] ? presetId : 'flat';
    this.preset = key;
    if (persist) {
      try { localStorage.setItem('ethio_audio_eq_preset', key); } catch { }
    }
    this._applyGains();
    return key;
  }

  _applyGains() {
    const gains = (EQ_PRESETS[this.preset] || EQ_PRESETS.flat).gains;
    this.filters.forEach((filter, idx) => {
      try {
        filter.gain.value = gains[idx] || 0;
      } catch { }
    });
  }

  /**
   * Safely wire a MediaElementAudioSourceNode if not yet attached and the element is CORS-safe.
   * Note: Once a media element has a MediaElementAudioSourceNode, all audio flows through Web Audio,
   * so we ONLY create the node when verified CORS-safe or local blob URL.
   *
   * @param {HTMLAudioElement} audioEl
   * @param {boolean} isCorsSafe
   * @returns {boolean}
   */
  ensureGraphForElement(audioEl, isCorsSafe) {
    if (!audioEl || typeof window === 'undefined') return false;
    if (this.attachedElement === audioEl && this.sourceNode) {
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => { });
      }
      return true;
    }
    if (!isCorsSafe) {
      return false;
    }

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return false;
      if (!this.audioCtx) {
        this.audioCtx = new AudioCtx();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => { });
      }

      this.sourceNode = this.audioCtx.createMediaElementSource(audioEl);
      this.filters = BAND_FREQUENCIES.map((freq, idx) => {
        const f = this.audioCtx.createBiquadFilter();
        f.type = idx === 0 ? 'lowshelf' : (idx === BAND_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking');
        f.frequency.value = freq;
        f.Q.value = 1.0;
        return f;
      });
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 64;
      this.analyser.smoothingTimeConstant = 0.8;
      this._freqData = new Uint8Array(this.analyser.frequencyBinCount);

      let prev = this.sourceNode;
      for (const f of this.filters) {
        prev.connect(f);
        prev = f;
      }
      prev.connect(this.analyser);
      this.analyser.connect(this.audioCtx.destination);

      this.attachedElement = audioEl;
      this.corsSafeAttached = true;
      this._applyGains();
      return true;
    } catch (err) {
      console.warn('AudioEqualizer graph skipped:', err);
      return false;
    }
  }

  /**
   * Returns normalized [0..1] low-mid energy for subtle stage glow reactivity.
   * Returns 0 if not attached cleanly.
   */
  getEnergyLevel() {
    if (!this.analyser || !this._freqData || !this.corsSafeAttached) return 0;
    try {
      this.analyser.getByteFrequencyData(this._freqData);
      let sum = 0;
      const bins = Math.min(8, this._freqData.length);
      for (let i = 0; i < bins; i++) sum += this._freqData[i];
      return Math.min(1, sum / (bins * 255));
    } catch {
      return 0;
    }
  }
}
