import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

import { escapeHtml, sanitizeUrl } from '../js/utils/sanitize.js';
import { LyricsParser } from '../js/lyrics-parser.js';
import { computeTarget, DriftController, GuestSyncEngine, HostBroadcaster } from '../js/party-sync.js';
import { RecommendationEngine } from '../js/recommendation-engine.js';
import { onRequestPost as uploadPostHandler, onRequestDelete as uploadDeleteHandler } from '../functions/api/upload.js';

const ROOT = process.cwd();

async function run() {
  console.log('1. Checking JS syntax across all modules...');
  const jsFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'libs') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) jsFiles.push(full);
    }
  };
  walk(ROOT);
  for (const f of jsFiles) {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  }
  console.log(`   OK (${jsFiles.length} JS files syntax-checked)`);

  console.log('2. Checking HTML DOM IDs & CSS integrity...');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const htmlIds = new Set([...html.matchAll(/id=["']([^"']+)["']/g)].map(m => m[1]));
  const appJs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const dynamicToastId = new Set(['appGlobalToast', 'btnEmptyUploadTrack', 'btnNoLyricsUploadLrc', 'btnNoLyricsOpenEditor']);
  const jsGetIds = [...appJs.matchAll(/document\.getElementById\(["']([^"']+)["']\)/g)].map(m => m[1]);
  const missingIds = [...new Set(jsGetIds.filter(id => !htmlIds.has(id) && !dynamicToastId.has(id)))];
  assert.deepEqual(missingIds, [], `Missing HTML IDs referenced in app.js: ${missingIds.join(', ')}`);

  const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
  assert.ok(css.includes('.app-global-toast'), 'Missing .app-global-toast CSS rule');
  assert.ok(css.includes('.empty-library-state'), 'Missing .empty-library-state CSS rule');
  assert.ok(css.includes('.scrubber-buffered'), 'Missing .scrubber-buffered CSS rule');
  assert.ok(css.includes('.volume-container.tray-active'), 'Missing .volume-container.tray-active CSS rule');
  assert.ok(css.includes('.player-bar-dock.is-collapsed'), 'Missing .player-bar-dock.is-collapsed CSS rule');
  assert.ok(css.includes('.btn-dock-collapse'), 'Missing .btn-dock-collapse CSS rule');
  assert.ok(css.includes('.btn-tray-mute'), 'Missing .btn-tray-mute CSS rule');
  assert.ok(css.includes('.track-card-actions'), 'Missing .track-card-actions CSS rule');
  assert.ok(css.includes('.btn-track-icon'), 'Missing .btn-track-icon CSS rule');
  assert.ok(css.includes('.scrubber-track.is-scrubbing'), 'Missing .scrubber-track.is-scrubbing CSS rule');
  assert.ok(css.includes('#app.perf-lite'), 'Missing #app.perf-lite CSS optimization rules');
  assert.ok(css.includes('.perf-mode-btn'), 'Missing .perf-mode-btn CSS rule');
  assert.ok(!fs.existsSync(path.join(ROOT, 'assets/abinet_portrait.jpg')), 'Duplicate abinet_portrait.jpg should be removed');
  assert.ok(!fs.existsSync(path.join(ROOT, 'js/data/sample-songs.js')), 'Unused sample-songs.js should be removed');
  console.log('   OK');

  console.log('3. Testing sanitize utilities...');
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(sanitizeUrl('javascript:alert(1)'), 'brand/elm-default-cover.svg');
  assert.equal(sanitizeUrl('data:text/html,<script>alert(1)</script>'), 'brand/elm-default-cover.svg');
  assert.equal(sanitizeUrl('https://pub-123.r2.dev/cover.jpg'), 'https://pub-123.r2.dev/cover.jpg');
  assert.equal(sanitizeUrl('assets/weleta_cover.jpg'), 'assets/weleta_cover.jpg');
  assert.equal(sanitizeUrl('brand/elm-default-cover.svg'), 'brand/elm-default-cover.svg');
  assert.equal(sanitizeUrl('assets/../local-sync-server.js'), 'brand/elm-default-cover.svg');
  console.log('   OK');

  console.log('4. Testing LyricsParser...');
  const parsed = LyricsParser.parse('\uFEFF[ti:Test]\n[00:10.50]First line\n[00:20.00][00:30.00]Chorus');
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].text, 'First line');
  assert.equal(LyricsParser.getActiveIndex(parsed, 0), -1);
  assert.equal(LyricsParser.getActiveIndex(parsed, 10.5), 0);
  assert.equal(LyricsParser.getActiveIndex(parsed, 15), 0);
  assert.equal(LyricsParser.getActiveIndex(parsed, 25), 1);
  assert.equal(LyricsParser.getActiveIndex(parsed, 99), 2);
  assert.equal(LyricsParser.getActiveIndex([], 10), -1);
  assert.equal(LyricsParser.estimateDurationFromLrc('[01:00.00]End'), 65);
  console.log('   OK');

  console.log('5. Testing RecommendationEngine...');
  const sampleTracks = [
    { id: 't1', title: 'Tizita', artist: 'Abinet', year: '2005', lrc: '[00:05.00]Line one\n[00:10.00]Line two\n[00:15.00]Line three' },
    { id: 't2', title: 'Selam', artist: 'Abinet', year: '2006', lrc: '' },
    { id: 't3', title: 'Addis', artist: 'Teddy', year: '2018', lrc: '' }
  ];
  const recs = RecommendationEngine.getPersonalizedRecommendations(sampleTracks, { favorites: ['t1'], recentlyPlayed: ['t2'], limit: 3 });
  assert.equal(recs.length, 3);
  const because = RecommendationEngine.getBecauseYouListenedShelf(sampleTracks, { recentlyPlayed: ['t1'] });
  assert.ok(because && because.seedArtist === 'Abinet' && because.tracks.length >= 1);
  assert.equal(RecommendationEngine.getBecauseYouListenedShelf([sampleTracks[0]], {}), null);
  console.log('   OK');

  console.log('6. Testing PartySync engine...');
  assert.equal(computeTarget({ state: 'playing', positionSec: 10, anchorServerMs: 1000, rate: 1 }, 3500), 12.5);
  const ctrl = new DriftController();
  const d = ctrl.decide(0.1, 5000);
  assert.equal(d.action, 'rate');
  assert.ok(d.rate > 1 && d.rate <= 1.04);

  let published = null;
  const hb = new HostBroadcaster({
    getState: () => ({ trackId: 't1', state: 'playing', positionSec: 5, rate: 1 }),
    publish: async (a) => { published = a; },
    clock: { now: () => 2000 },
    getLatencySec: () => 0
  });
  hb.flush(true, 'manual');
  assert.ok(published && published.epoch === 1 && published.trackId === 't1');
  hb.stop();

  let guestPos = 0;
  const gs = new GuestSyncEngine({
    player: {
      getPosition: () => guestPos,
      isPlaying: () => true,
      getDuration: () => 200,
      seek: (s) => { guestPos = s; },
      play: async () => true,
      pause: () => {},
      setRateMultiplier: () => {},
      setBaseRate: () => {}
    },
    clock: { now: () => 2000 },
    getLatencySec: () => 0
  });
  gs.setTrackReady(true);
  gs.setAnchor({ trackId: 't1', state: 'playing', positionSec: 20, anchorServerMs: 2000, rate: 1, epoch: 1 });
  assert.ok(guestPos >= 20);
  gs.stop();
  console.log('   OK');

  console.log('7. Testing local-sync-server.js HTTP security & streaming...');
  execFileSync(process.execPath, ['local-sync-server.js', '--test'], { stdio: 'pipe' });

  const testPort = 3987;
  const srv = spawn(process.execPath, ['local-sync-server.js'], {
    env: { ...process.env, PORT: String(testPort) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const waitReady = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timeout')), 4000);
    srv.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Status: Active')) {
        clearTimeout(timer);
        resolve();
      }
    });
    srv.stderr.on('data', (chunk) => {
      // ignore non-fatal
    });
  });

  const req = (reqPath, opts = {}) => new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port: testPort, path: reqPath, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });

  try {
    await waitReady();
    const tRes = await req('/api/time');
    assert.equal(tRes.status, 200);
    assert.equal(JSON.parse(tRes.body.toString()).ok, true);

    const badUri = await req('/%E0%A4%A');
    assert.equal(badUri.status, 400);

    const dotBlocked = await req('/.gitignore');
    assert.equal(dotBlocked.status, 403);

    const srvBlocked = await req('/local-sync-server.js');
    assert.equal(srvBlocked.status, 403);

    const docsBlocked = await req('/docs/PARTY_MODE_SYNC.md');
    assert.equal(docsBlocked.status, 403);

    const upRes = await req('/api/stream/upload/track_test', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: Buffer.from('0123456789ABCDEF')
    });
    assert.equal(upRes.status, 200);

    const rangeOk = await req('/api/stream/audio/track_test', { headers: { Range: 'bytes=0-3' } });
    assert.equal(rangeOk.status, 206);
    assert.equal(rangeOk.body.toString(), '0123');

    const rangeBad = await req('/api/stream/audio/track_test', { headers: { Range: 'bytes=999-1000' } });
    assert.equal(rangeBad.status, 416);
    console.log('   OK');
  } finally {
    srv.kill();
  }

  console.log('8. Testing AudioPlayer progressive streaming & no-synth fallback...');
  const listenersMap = {};
  const fakeAudioEl = {
    preload: '',
    crossOrigin: '',
    src: '',
    volume: 1,
    playbackRate: 1,
    duration: 180,
    currentTime: 0,
    buffered: { length: 1, start: () => 0, end: () => 45 },
    paused: true,
    error: null,
    addEventListener: (evt, fn) => { listenersMap[evt] = fn; },
    getAttribute: (attr) => (attr === 'src' ? (fakeAudioEl.src || null) : null),
    removeAttribute: (attr) => {
      if (attr === 'src') fakeAudioEl.src = '';
      if (attr === 'crossOrigin') fakeAudioEl.crossOrigin = '';
    },
    pause: () => { fakeAudioEl.paused = true; },
    play: async () => { fakeAudioEl.paused = false; },
    load: () => {}
  };
  const origAudio = globalThis.Audio;
  const origRaf = globalThis.requestAnimationFrame;
  const origCaf = globalThis.cancelAnimationFrame;
  const origCreateObjectURL = globalThis.URL.createObjectURL;
  const origRevokeObjectURL = globalThis.URL.revokeObjectURL;
  globalThis.Audio = function () { return fakeAudioEl; };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.URL.createObjectURL = () => 'blob:mock';
  globalThis.URL.revokeObjectURL = () => {};
  try {
    const { AudioPlayer } = await import('../js/player.js');
    const testPlayer = new AudioPlayer();
    let lastPlayerError = null;
    let lastBufferPct = 0;
    testPlayer.onError = (msg) => { lastPlayerError = msg; };
    testPlayer.onBufferUpdate = (pct) => { lastBufferPct = pct; };

    // Real track missing audio must NOT enable synthetic fallback
    testPlayer.loadTrack({ id: 'pub_missing', title: 'No Audio Track' });
    assert.equal(testPlayer.isSynthetic, false);
    assert.equal(testPlayer.hasAudioSource, false);
    const playedMissing = await testPlayer.play();
    assert.equal(playedMissing, false);
    assert.ok(lastPlayerError && lastPlayerError.includes('No audio stream'), 'Should report missing audio stream');

    // Streaming track uses metadata preload initially, switches to auto on play, and encodes non-ASCII URLs
    testPlayer.loadTrack({ id: 'pub_stream', title: 'Stream', audioUrl: 'https://pub-test.r2.dev/በስምህ ታምኛለው.mp3' });
    assert.equal(testPlayer.hasAudioSource, true);
    assert.equal(fakeAudioEl.preload, 'metadata');
    assert.ok(!fakeAudioEl.src.includes(' '), 'Stream URL spaces must be percent-encoded');
    listenersMap.progress();
    assert.equal(lastBufferPct, 25);
    const playedStream = await testPlayer.play();
    assert.equal(playedStream, true);
    assert.equal(fakeAudioEl.preload, 'auto');

    // Simulate CORS retry + MediaError.code without accessing MediaError.message
    fakeAudioEl.crossOrigin = 'anonymous';
    fakeAudioEl.error = { code: 2 };
    listenersMap.error();
    assert.equal(fakeAudioEl.crossOrigin, '');
    listenersMap.error();
    assert.ok(lastPlayerError && lastPlayerError.includes('Network error'), 'Should emit code-mapped audio error');
    testPlayer.pause();

    const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    assert.ok(swSrc.includes('url.origin !== self.location.origin'), 'Service worker must skip all cross-origin requests');
  } finally {
    globalThis.Audio = origAudio;
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCaf;
    globalThis.URL.createObjectURL = origCreateObjectURL;
    globalThis.URL.revokeObjectURL = origRevokeObjectURL;
  }
  console.log('   OK');

  console.log('9. Testing functions/api/upload.js Cloudflare R2 guardrails...');
  const noBucketRes = await uploadPostHandler({
    request: new Request('https://example.com/api/upload', { method: 'POST' }),
    env: {}
  });
  assert.equal(noBucketRes.status, 503);

  const noAuthRes = await uploadPostHandler({
    request: new Request('https://example.com/api/upload', { method: 'POST' }),
    env: { MEDIA_BUCKET: { put: async () => {} } }
  });
  assert.equal(noAuthRes.status, 401);

  const noBucketDel = await uploadDeleteHandler({
    request: new Request('https://example.com/api/upload', { method: 'DELETE' }),
    env: {}
  });
  assert.equal(noBucketDel.status, 503);

  const noAuthDel = await uploadDeleteHandler({
    request: new Request('https://example.com/api/upload', { method: 'DELETE' }),
    env: { MEDIA_BUCKET: { delete: async () => {} } }
  });
  assert.equal(noAuthDel.status, 401);
  console.log('   OK');

  console.log('\nALL TESTS PASSED!');
}

run().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
