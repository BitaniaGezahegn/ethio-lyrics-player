/**
 * Party Mode Sync Engine v2 — Anchor Timeline + Local Control Loop
 *
 * Pure logic module: NO DOM and NO Firebase imports, so it can be unit-tested in Node.
 * Everything environment-specific (player, clock, timers, publishing) is dependency-injected.
 *
 * Core idea:
 *   The host publishes a timeline *anchor* only on discrete events (play/pause/seek/track/rate/stall):
 *     { trackId, state, positionSec, anchorServerMs, rate, epoch }
 *   Every guest computes where playback SHOULD be at any moment:
 *     target(t) = positionSec + (serverNow(t) - anchorServerMs) / 1000 * rate
 *   and runs a local control loop (every 250ms) that nudges its playbackRate proportionally
 *   to the measured drift, or hard-seeks when the drift is too large / the epoch changed.
 *
 * Latency model (Bluetooth / output delay):
 *   acoustic position = element position - own output latency.
 *   Host publishes ACOUSTIC positions; guests target element = acoustic target + own latency.
 */

export const SYNC_CONFIG = Object.freeze({
  tickMs: 250,              // guest control-loop period
  medianWindow: 5,          // drift samples for median filter (~1.25s)
  deadbandEnterSec: 0.040,  // start correcting above 40ms
  deadbandExitSec: 0.015,   // stop correcting below 15ms (hysteresis → no oscillation)
  kp: 0.30,                 // rate delta per second of drift (100ms → +3%)
  maxRateDelta: 0.04,       // clamp ±4% (pitch is preserved by the media element)
  minRateStep: 0.002,       // don't touch playbackRate for tiny changes
  hardSeekSec: 0.80,        // beyond this, seek instead of stretching time
  hardSeekMinSamples: 3,    // require N samples above threshold before seeking (glitch immunity)
  instantSeekSec: 3.0,      // ...unless the drift is enormous
  settleMs: 1200,           // ignore drift right after a seek/play while the decoder settles
  initialSeekLeadSec: 0.15, // initial seek-ahead compensation
  maxSeekLeadSec: 1.5,
  seekLeadGain: 0.6,        // how fast the learned seek lead adapts to landing error
  inSyncSec: 0.040,         // status "In sync" threshold
  endGuardSec: 0.25,        // don't try to play when the target is past the end of the track
  hostSelfCheckMs: 2000,    // host re-anchors if its own audio drifts from its anchor (stall)
  hostReanchorSec: 0.15,
  hostDebounceMs: 80,       // coalesce bursts of host events into one write
  hostSeekDebounceMs: 250,  // scrubbing drags → 1 write
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Where playback SHOULD be right now on the acoustic timeline (seconds). */
export function computeTarget(pb, serverNowMs) {
  if (!pb) return 0;
  const pos = Number(pb.positionSec) || 0;
  if (pb.state !== 'playing') return pos;
  const anchorMs = Number(pb.anchorServerMs);
  const elapsedSec = Number.isFinite(anchorMs) ? Math.max(0, (serverNowMs - anchorMs) / 1000) : 0;
  const rate = Number(pb.rate);
  return pos + elapsedSec * (Number.isFinite(rate) && rate > 0 ? rate : 1);
}

/** Has the anchor meaningfully changed (vs. an unrelated doc update like a host rename)? */
export function anchorChanged(a, b) {
  if (!a || !b) return a !== b;
  return a.epoch !== b.epoch ||
    a.state !== b.state ||
    a.trackId !== b.trackId ||
    a.anchorServerMs !== b.anchorServerMs ||
    a.positionSec !== b.positionSec ||
    a.rate !== b.rate;
}

/**
 * Drift controller: median filter + hysteresis deadband + proportional rate control,
 * hard-seek decisions, and a self-learning seek-ahead lead.
 */
export class DriftController {
  constructor(config = SYNC_CONFIG) {
    this.cfg = config;
    this.samples = [];
    this.correcting = false;
    this.settleUntil = 0;
    this.seekLeadSec = config.initialSeekLeadSec;
    this.awaitingLanding = false;
    this.lastMedian = 0;
  }

  reset() {
    this.samples = [];
    this.correcting = false;
    this.lastMedian = 0;
  }

  /** Call right after issuing a hard seek / play. */
  beginSettle(nowMs, learnLanding = true) {
    this.reset();
    this.settleUntil = nowMs + this.cfg.settleMs;
    this.awaitingLanding = learnLanding;
  }

  isSettling(nowMs) {
    return nowMs < this.settleUntil;
  }

  /**
   * Feed the landing error measured right after settling.
   * Positive drift = we landed behind → increase lead; negative = ahead → decrease lead.
   */
  learnLanding(driftSec) {
    const next = this.seekLeadSec + this.cfg.seekLeadGain * driftSec;
    this.seekLeadSec = clamp(next, 0, this.cfg.maxSeekLeadSec);
    this.awaitingLanding = false;
    return this.seekLeadSec;
  }

  /**
   * @param {number} driftSec  target - actual (positive = behind host)
   * @param {number} nowMs     monotonic ms
   * @returns {{action:'none'|'rate'|'seek', rate:number, median:number, learned?:number}}
   */
  decide(driftSec, nowMs) {
    const cfg = this.cfg;
    if (this.isSettling(nowMs)) {
      return { action: 'none', rate: 1, median: driftSec, settling: true };
    }

    let learned;
    if (this.awaitingLanding) {
      learned = this.learnLanding(driftSec);
      // Landing error is now accounted for in the lead; still evaluate this sample below.
    }

    if (Math.abs(driftSec) > cfg.instantSeekSec) {
      return { action: 'seek', rate: 1, median: driftSec, learned };
    }

    this.samples.push(driftSec);
    if (this.samples.length > cfg.medianWindow) this.samples.shift();
    const med = median(this.samples);
    this.lastMedian = med;

    if (Math.abs(med) > cfg.hardSeekSec && this.samples.length >= cfg.hardSeekMinSamples) {
      return { action: 'seek', rate: 1, median: med, learned };
    }

    const absMed = Math.abs(med);
    if (this.correcting) {
      if (absMed < cfg.deadbandExitSec) this.correcting = false;
    } else if (absMed > cfg.deadbandEnterSec) {
      this.correcting = true;
    }

    const rate = this.correcting ? 1 + clamp(cfg.kp * med, -cfg.maxRateDelta, cfg.maxRateDelta) : 1;
    return { action: 'rate', rate, median: med, learned };
  }
}

/**
 * Guest engine: follows the host's anchor with a local control loop.
 *
 * deps:
 *   player: {
 *     getPosition(): number, isPlaying(): boolean, getDuration(): number,
 *     seek(sec), play(): Promise<boolean>, pause(),
 *     setRateMultiplier(m), setBaseRate(r)
 *   }
 *   clock: { now(): serverMs }
 *   getLatencySec(): number
 *   onStatus(status)
 *   nowMs(): monotonic ms (default performance.now / Date.now)
 *   timers: { setInterval, clearInterval }
 */
export class GuestSyncEngine {
  constructor(deps, config = SYNC_CONFIG) {
    this.d = deps;
    this.cfg = config;
    this.ctrl = new DriftController(config);
    this.anchor = null;
    this.trackReady = false;
    this.pendingHard = true;
    this.blocked = false;
    this.playPending = false;
    this.buffering = false;
    this.currentMultiplier = 1;
    this.timer = null;
    this.lastStatus = null;
    this.lastDriftSec = 0;
    this.lastAction = 'init';
    this.stats = { hardSeeks: 0, rateChanges: 0 };
    this._now = deps.nowMs || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._timers = deps.timers || { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (id) => clearInterval(id) };
  }

  start() {
    this.stop();
    this.timer = this._timers.setInterval(() => this.tick(), this.cfg.tickMs);
  }

  stop() {
    if (this.timer != null) this._timers.clearInterval(this.timer);
    this.timer = null;
    this._setMultiplier(1, true);
  }

  get running() {
    return this.timer != null;
  }

  /** New anchor from the room document. Epoch change → hard sync on next tick. */
  setAnchor(pb) {
    if (!pb) return;
    const prev = this.anchor;
    this.anchor = { ...pb };
    if (!prev || prev.epoch !== pb.epoch || prev.trackId !== pb.trackId) {
      this.pendingHard = true;
    }
    this.tick();
  }

  setTrackReady(ready) {
    this.trackReady = !!ready;
    if (ready) this.pendingHard = true;
  }

  requestResync() {
    this.pendingHard = true;
    this.blocked = false;
    this.tick();
  }

  /** Must be called from inside a user gesture (tap) to satisfy autoplay policies. */
  unlockFromGesture() {
    this.blocked = false;
    this.pendingHard = true;
    this.tick();
  }

  notifyWaiting() {
    this.buffering = true;
    this._emit();
  }

  notifyPlaying() {
    this.buffering = false;
  }

  _setMultiplier(m, force = false) {
    if (force || m === 1 || Math.abs(m - this.currentMultiplier) >= this.cfg.minRateStep) {
      if (m !== this.currentMultiplier) this.stats.rateChanges++;
      this.currentMultiplier = m;
      this.d.player.setRateMultiplier(m);
    }
  }

  _hardSync(targetElement, nowMs) {
    const p = this.d.player;
    const isPlayingState = this.anchor && this.anchor.state === 'playing';
    const lead = isPlayingState ? this.ctrl.seekLeadSec : 0;
    this.stats.hardSeeks++;
    this.lastAction = 'hard-seek';
    this._setMultiplier(1, true);
    p.seek(Math.max(0, targetElement + lead));
    this.ctrl.beginSettle(nowMs, isPlayingState);
    this.pendingHard = false;

    if (isPlayingState && !p.isPlaying() && !this.playPending) {
      this.playPending = true;
      Promise.resolve(p.play()).then((ok) => {
        this.playPending = false;
        if (ok === false) {
          this.blocked = true;
          this.lastAction = 'autoplay-blocked';
        }
        this._emit();
      }).catch(() => {
        this.playPending = false;
        this.blocked = true;
        this._emit();
      });
    }
  }

  tick() {
    const p = this.d.player;
    const nowMs = this._now();
    const a = this.anchor;

    if (!a || !this.trackReady) {
      this._emit('loading');
      return;
    }

    p.setBaseRate(Number(a.rate) || 1);
    const latency = Number(this.d.getLatencySec ? this.d.getLatencySec() : 0) || 0;
    const targetElement = computeTarget(a, this.d.clock.now()) + latency;
    const duration = p.getDuration ? p.getDuration() : 0;

    // ---- Paused / loading host: mirror position, no rate games ----
    if (a.state !== 'playing') {
      if (p.isPlaying()) p.pause();
      this._setMultiplier(1, true);
      const pos = p.getPosition();
      if (this.pendingHard || Math.abs(targetElement - pos) > 0.05) {
        p.seek(Math.max(0, targetElement));
        this.pendingHard = false;
      }
      this.lastDriftSec = 0;
      this._emit(a.state === 'loading' ? 'loading' : 'paused');
      return;
    }

    // ---- Host is playing ----
    if (duration > 0 && targetElement >= duration - this.cfg.endGuardSec) {
      // Host is about to switch tracks; don't loop on the tail.
      this._emit('waiting-host');
      return;
    }

    if (this.blocked) {
      this._emit('blocked');
      return;
    }

    if (this.pendingHard || (!p.isPlaying() && !this.playPending)) {
      this._hardSync(targetElement, nowMs);
      this._emit('syncing');
      return;
    }

    if (this.playPending) {
      this._emit('syncing');
      return;
    }

    if (this.buffering) {
      this._emit('buffering');
      return;
    }

    const drift = targetElement - p.getPosition();
    this.lastDriftSec = drift;
    const decision = this.ctrl.decide(drift, nowMs);

    if (decision.action === 'seek') {
      this._hardSync(targetElement, nowMs);
      this._emit('syncing');
      return;
    }
    if (decision.action === 'rate') {
      this._setMultiplier(decision.rate);
      this.lastAction = decision.rate === 1 ? 'locked' : 'rate';
    }

    const settling = decision.settling;
    const inSync = !settling && !this.ctrl.correcting && Math.abs(decision.median) < this.cfg.inSyncSec;
    this._emit(inSync ? 'in-sync' : 'syncing');
  }

  getDebugInfo() {
    return {
      anchor: this.anchor,
      driftMs: Math.round(this.lastDriftSec * 1000),
      medianMs: Math.round(this.ctrl.lastMedian * 1000),
      rate: this.currentMultiplier,
      seekLeadMs: Math.round(this.ctrl.seekLeadSec * 1000),
      correcting: this.ctrl.correcting,
      lastAction: this.lastAction,
      state: this.lastStatus,
      stats: { ...this.stats },
    };
  }

  _emit(state) {
    if (state) this.lastStatus = state;
    if (this.d.onStatus) {
      this.d.onStatus({
        state: this.lastStatus,
        driftMs: Math.round((this.ctrl.lastMedian || this.lastDriftSec) * 1000),
        rate: this.currentMultiplier,
      });
    }
  }
}

/**
 * Host broadcaster: turns player events into timeline anchors.
 *
 * deps:
 *   getState(): { trackId, state: 'playing'|'paused'|'loading', positionSec (element), rate }
 *   publish(anchor, { trackChanged }): Promise
 *   clock: { now(): serverMs }
 *   getLatencySec(): number
 *   nowMs(), timers: { setTimeout, clearTimeout, setInterval, clearInterval }
 */
export class HostBroadcaster {
  constructor(deps, config = SYNC_CONFIG) {
    this.d = deps;
    this.cfg = config;
    this.epoch = 0;
    this.lastAnchor = null;
    this.lastTrackId = null;
    this._pendingTimer = null;
    this._pendingBump = false;
    this._checkTimer = null;
    this.publishCount = 0;
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    this._timers = deps.timers || {
      setTimeout: (f, ms) => g.setTimeout(f, ms),
      clearTimeout: (id) => g.clearTimeout(id),
      setInterval: (f, ms) => g.setInterval(f, ms),
      clearInterval: (id) => g.clearInterval(id),
    };
  }

  /** @param {object|null} existingPlayback  room.playback when taking over */
  start(existingPlayback = null) {
    this.stop();
    this.epoch = existingPlayback && Number.isFinite(existingPlayback.epoch) ? existingPlayback.epoch : 0;
    this.lastAnchor = existingPlayback ? { ...existingPlayback } : null;
    this.lastTrackId = existingPlayback ? existingPlayback.trackId : null;
    this._checkTimer = this._timers.setInterval(() => this.selfCheck(), this.cfg.hostSelfCheckMs);
  }

  stop() {
    if (this._pendingTimer != null) this._timers.clearTimeout(this._pendingTimer);
    if (this._checkTimer != null) this._timers.clearInterval(this._checkTimer);
    this._pendingTimer = null;
    this._checkTimer = null;
    this._pendingBump = false;
  }

  get running() {
    return this._checkTimer != null;
  }

  /** Schedule a coalesced publish. reason: 'play'|'pause'|'seek'|'track'|'rate'|'ended'|'takeover' */
  notify(reason, { bumpEpoch = true, immediate = false } = {}) {
    this._pendingBump = this._pendingBump || bumpEpoch;
    if (this._pendingTimer != null) this._timers.clearTimeout(this._pendingTimer);
    const delay = immediate ? 0 : (reason === 'seek' ? this.cfg.hostSeekDebounceMs : this.cfg.hostDebounceMs);
    this._pendingTimer = this._timers.setTimeout(() => {
      this._pendingTimer = null;
      const bump = this._pendingBump;
      this._pendingBump = false;
      this.flush(bump, reason);
    }, delay);
  }

  buildAnchor(bumpEpoch) {
    const s = this.d.getState();
    const latency = Number(this.d.getLatencySec ? this.d.getLatencySec() : 0) || 0;
    if (bumpEpoch) this.epoch += 1;
    return {
      trackId: s.trackId || null,
      state: s.state,
      positionSec: Math.max(0, Math.round(((Number(s.positionSec) || 0) - latency) * 1000) / 1000),
      anchorServerMs: Math.round(this.d.clock.now()),
      rate: Number(s.rate) || 1,
      epoch: this.epoch,
    };
  }

  flush(bumpEpoch = true, reason = 'manual') {
    const anchor = this.buildAnchor(bumpEpoch);
    const trackChanged = anchor.trackId !== this.lastTrackId;
    this.lastAnchor = anchor;
    this.lastTrackId = anchor.trackId;
    this.publishCount++;
    this.lastReason = reason;
    return Promise.resolve(this.d.publish(anchor, { trackChanged, reason })).catch(() => {});
  }

  /** Detect host-side stalls (buffering) or state mismatch and re-anchor softly. */
  selfCheck() {
    if (this._pendingTimer != null) return; // a publish is already on its way
    const s = this.d.getState();
    const a = this.lastAnchor;
    if (!a) {
      this.notify('init', { immediate: true });
      return;
    }
    if (s.state !== a.state || s.trackId !== a.trackId || (Number(s.rate) || 1) !== a.rate) {
      this.notify('state-mismatch', { immediate: true });
      return;
    }
    if (s.state !== 'playing') return;
    const latency = Number(this.d.getLatencySec ? this.d.getLatencySec() : 0) || 0;
    const expected = computeTarget(a, this.d.clock.now());
    const actual = (Number(s.positionSec) || 0) - latency;
    if (Math.abs(actual - expected) > this.cfg.hostReanchorSec) {
      // Soft re-anchor: same epoch → guests correct smoothly (or seek if far off).
      this.flush(false, 'self-check');
    }
  }
}
