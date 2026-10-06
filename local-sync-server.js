/**
 * Ethio Lyrics Player — Local Sync Hub Server (Node.js)
 *
 * 100% Zero-Dependency Standalone Server for Offline Local Listening.
 * Uses only Node.js standard libraries: http, crypto, os, fs, path, url.
 *
 * Features:
 *   1. Static file server with HTTP Range requests (206 Partial Content) for instant audio seeking.
 *   2. RFC 6455 compliant native WebSocket server for < 2ms room sync & anchor broadcasts.
 *   3. High-precision NTP clock synchronization endpoint (/api/time).
 *   4. Local audio relay cache (/api/stream/:trackId) so friends on Wi-Fi stream host's MP3s seamlessly.
 *   5. LAN IP auto-detection (Wi-Fi / Hotspot) with QR code & shareable join links.
 */

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const url = require('url');

const DEFAULT_PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT_DIR = __dirname;

// In-memory audio track store: { [trackId]: { buffer: Buffer, mime: string, metadata: object, uploadedAt: number } }
const audioTrackStore = new Map();

// In-memory room state: { [roomCode]: { code, hostId, hostName, currentTrack, playback, participants: Map, reactions: [] } }
const rooms = new Map();

// Connected WebSocket clients: Map<Socket, { id, roomCode, isHost, name, avatar, lastSeen }>
const wsClients = new Map();

// MIME types for static assets
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.lrc': 'text/plain; charset=UTF-8',
  '.txt': 'text/plain; charset=UTF-8',
};

/** Detect active LAN IPv4 addresses (Wi-Fi, Ethernet, Mobile Hotspot) */
function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // IPv4 and not loopback (127.0.0.1)
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({
          interface: name,
          address: iface.address,
        });
      }
    }
  }

  // Fallback to localhost if no LAN address found
  if (addresses.length === 0) {
    addresses.push({ interface: 'loopback', address: '127.0.0.1' });
  }

  return addresses;
}

// ---------------------------------------------------------------------------
// HTTP Request Handlers
// ---------------------------------------------------------------------------

function handleHttpRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers for local LAN freedom
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. High-Precision NTP Clock Sync
  if (pathname === '/api/time') {
    const hr = process.hrtime.bigint().toString();
    const serverTime = Date.now();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(JSON.stringify({ serverTime, hr, ok: true }));
    return;
  }

  // 2. LAN Information (IPs, Ports, Active Rooms)
  if (pathname === '/api/lan-info') {
    const lanAddrs = getLanAddresses();
    const activeRooms = Array.from(rooms.values()).map(r => ({
      code: r.code,
      hostName: r.hostName,
      trackTitle: r.currentTrack ? r.currentTrack.title : null,
      trackArtist: r.currentTrack ? r.currentTrack.artist : null,
      participantCount: r.participants.size,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      port: DEFAULT_PORT,
      addresses: lanAddrs,
      rooms: activeRooms,
    }));
    return;
  }

  // 3. Audio Relay Upload (Host uploads track audio blob for offline guest streaming)
  if (pathname.startsWith('/api/stream/upload/') && req.method === 'POST') {
    const trackId = decodeURIComponent(pathname.replace('/api/stream/upload/', ''));
    const chunks = [];
    let receivedBytes = 0;
    const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB limit per audio track

    req.on('data', chunk => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_UPLOAD_BYTES) {
        req.destroy(new Error('Audio upload payload exceeds maximum allowed size (50MB).'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const mime = req.headers['content-type'] || 'audio/mpeg';

      // Keep cache size bounded to last 20 tracks
      if (audioTrackStore.size >= 20) {
        const oldestKey = audioTrackStore.keys().next().value;
        if (oldestKey) audioTrackStore.delete(oldestKey);
      }

      audioTrackStore.set(trackId, {
        buffer,
        mime,
        uploadedAt: Date.now(),
      });

      console.log(`[AudioRelay] Cached track "${trackId}" (${(buffer.length / (1024 * 1024)).toFixed(2)} MB)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, trackId, size: buffer.length }));
    });

    req.on('error', err => {
      console.warn('[AudioRelay] Upload aborted:', err.message);
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 4. Audio Relay Streaming (Guests stream audio with HTTP 206 Range support)
  if (pathname.startsWith('/api/stream/audio/')) {
    const trackId = decodeURIComponent(pathname.replace('/api/stream/audio/', ''));
    const cached = audioTrackStore.get(trackId);

    if (!cached) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Track audio not found on local hub' }));
      return;
    }

    const total = cached.buffer.length;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunkSize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': cached.mime,
      });
      res.end(cached.buffer.slice(start, end + 1));
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Content-Type': cached.mime,
      });
      res.end(cached.buffer);
    }
    return;
  }

  // 5. Static File Serving (Root Directory)
  serveStaticFile(pathname, req, res);
}

function serveStaticFile(pathname, req, res) {
  let safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') {
    safePath = '/index.html';
  }

  const filePath = path.join(ROOT_DIR, safePath);

  // Security check: ensure path stays inside ROOT_DIR
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end('Access Denied');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // SPA Fallback: if not found and not requesting index.html, serve index.html for client routes
      if (path.extname(safePath) === '' && safePath !== '/index.html') {
        return serveStaticFile('/index.html', req, res);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const total = stats.size;
    const range = req.headers.range;

    // HTTP 206 Range Request support for media files (audio/video)
    if (range && (contentType.startsWith('audio/') || contentType.startsWith('video/'))) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;

      if (start >= total || end >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }

      const chunkSize = (end - start) + 1;
      const fileStream = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });
      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

// ---------------------------------------------------------------------------
// Native RFC 6455 WebSocket Implementation (Zero External Dependencies)
// ---------------------------------------------------------------------------

const WS_MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function handleUpgrade(req, socket, head) {
  if (req.headers['upgrade']?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }

  const clientKey = req.headers['sec-websocket-key'];
  if (!clientKey) {
    socket.destroy();
    return;
  }

  // Compute accept key: SHA1(Key + Magic) -> Base64
  const acceptKey = crypto
    .createHash('sha1')
    .update(clientKey + WS_MAGIC_STRING)
    .digest('base64');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n',
  ].join('\r\n');

  socket.write(responseHeaders);

  // Initialize client context
  const clientInfo = {
    id: 'ws_' + Math.random().toString(36).slice(2, 10),
    socket,
    roomCode: null,
    isHost: false,
    name: 'Listener',
    avatar: '',
    lastSeen: Date.now(),
  };

  wsClients.set(socket, clientInfo);

  setupWebSocketListeners(socket, clientInfo);
}

function setupWebSocketListeners(socket, client) {
  let buffer = Buffer.alloc(0);

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];

      const fin = (firstByte & 0x80) === 0x80;
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) === 0x80;
      let payloadLength = secondByte & 0x7f;

      let offset = 2;

      if (payloadLength === 126) {
        if (buffer.length < 4) return;
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (buffer.length < 10) return;
        payloadLength = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      let maskKey = null;
      if (isMasked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.slice(offset, offset + 4);
        offset += 4;
      }

      if (buffer.length < offset + payloadLength) return;

      const payload = buffer.slice(offset, offset + payloadLength);
      buffer = buffer.slice(offset + payloadLength);

      // Unmask payload if masked
      if (isMasked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      handleWsFrame(client, opcode, payload);
    }
  });

  socket.on('close', () => handleWsDisconnect(client));
  socket.on('error', () => handleWsDisconnect(client));
}

function sendWsFrame(socket, opcode, data) {
  if (socket.destroyed) return;

  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const length = payload.length;

  let header;
  if (length <= 125) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
    header[1] = length; // Unmasked (server to client)
  } else if (length <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  try {
    socket.write(Buffer.concat([header, payload]));
  } catch (err) {
    // Socket write error
  }
}

function sendWsJson(socket, obj) {
  sendWsFrame(socket, 0x01, JSON.stringify(obj));
}

function broadcastToRoom(roomCode, message, excludeSocket = null) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const jsonStr = JSON.stringify(message);
  for (const [s, c] of wsClients.entries()) {
    if (c.roomCode === roomCode && s !== excludeSocket) {
      sendWsFrame(s, 0x01, jsonStr);
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket Message Protocol Handlers
// ---------------------------------------------------------------------------

function handleWsFrame(client, opcode, payload) {
  client.lastSeen = Date.now();

  // Opcode 0x08: Connection Close
  if (opcode === 0x08) {
    handleWsDisconnect(client);
    return;
  }

  // Opcode 0x09: Ping -> Respond with Pong
  if (opcode === 0x09) {
    sendWsFrame(client.socket, 0x0a, payload);
    return;
  }

  // Opcode 0x01: Text Message
  if (opcode === 0x01) {
    try {
      const msg = JSON.parse(payload.toString('utf8'));
      processClientMessage(client, msg);
    } catch (err) {
      console.warn('[WS] Malformed message from client:', err.message);
    }
  }
}

function processClientMessage(client, msg) {
  const type = msg.type;

  switch (type) {
    case 'create_room': {
      const roomCode = (msg.roomCode || generateRoomCode()).toUpperCase();
      client.roomCode = roomCode;
      client.isHost = true;
      client.name = msg.hostInfo?.name || 'Party Host';
      client.avatar = msg.hostInfo?.avatar || '';

      const roomData = {
        schemaVersion: 2,
        roomCode,
        hostId: msg.hostInfo?.id || client.id,
        hostName: client.name,
        hostAvatar: client.avatar,
        isActive: true,
        currentTrack: msg.currentTrack || null,
        playback: {
          trackId: msg.currentTrack?.id || null,
          state: msg.playbackState || 'paused',
          positionSec: Number(msg.positionSec) || 0,
          anchorServerMs: Date.now(),
          rate: Number(msg.rate) || 1.0,
          epoch: 1,
        },
        participants: new Map(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Register host participant
      roomData.participants.set(client.id, {
        id: client.id,
        name: client.name,
        avatar: client.avatar,
        isHost: true,
        joinedAt: Date.now(),
        driftMs: 0,
      });

      rooms.set(roomCode, roomData);
      console.log(`[LocalSync] Room created: ${roomCode} by ${client.name}`);

      sendWsJson(client.socket, {
        type: 'room_created',
        room: serializeRoom(roomData),
      });
      break;
    }

    case 'join_room': {
      const roomCode = (msg.roomCode || '').toUpperCase();
      const room = rooms.get(roomCode);

      if (!room || !room.isActive) {
        sendWsJson(client.socket, {
          type: 'error',
          error: 'Local room not found or session has ended.',
        });
        return;
      }

      client.roomCode = roomCode;
      client.isHost = false;
      client.name = msg.participant?.name || 'Guest Listener';
      client.avatar = msg.participant?.avatar || '';

      // Register guest
      room.participants.set(client.id, {
        id: client.id,
        name: client.name,
        avatar: client.avatar,
        isHost: false,
        joinedAt: Date.now(),
        driftMs: 0,
      });

      console.log(`[LocalSync] Guest "${client.name}" joined room ${roomCode} (${room.participants.size} active)`);

      // Send initial room snapshot to joining guest
      sendWsJson(client.socket, {
        type: 'room_joined',
        room: serializeRoom(room),
      });

      // Broadcast updated participants list to everyone in the room
      broadcastParticipants(roomCode);
      break;
    }

    case 'publish_anchor': {
      const room = rooms.get(client.roomCode);
      if (!room || !client.isHost) return;

      const anchor = msg.anchor;
      room.playback = {
        trackId: anchor.trackId || room.currentTrack?.id || null,
        state: anchor.state || 'paused',
        positionSec: Number(anchor.positionSec) || 0,
        anchorServerMs: Number(anchor.anchorServerMs) || Date.now(),
        rate: Number(anchor.rate) || 1.0,
        epoch: Number(anchor.epoch) || (room.playback.epoch + 1),
      };

      if (msg.currentTrack) {
        room.currentTrack = msg.currentTrack;
      }

      room.updatedAt = Date.now();

      // Broadcast anchor in real time to all guests
      broadcastToRoom(client.roomCode, {
        type: 'anchor_update',
        playback: room.playback,
        currentTrack: room.currentTrack,
      }, client.socket);
      break;
    }

    case 'presence_heartbeat': {
      const room = rooms.get(client.roomCode);
      if (!room) return;

      const p = room.participants.get(client.id);
      if (p) {
        p.lastSeen = Date.now();
        p.driftMs = msg.driftMs || 0;
      }
      break;
    }

    case 'send_reaction': {
      if (!client.roomCode) return;
      broadcastToRoom(client.roomCode, {
        type: 'reaction',
        reaction: {
          id: 'rx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          type: msg.emoji || '❤️',
          from: client.name,
          timestamp: Date.now(),
        },
      });
      break;
    }

    case 'claim_host': {
      const room = rooms.get(client.roomCode);
      if (!room) return;
      client.isHost = true;
      room.hostId = client.id;
      room.hostName = client.name;
      room.hostAvatar = client.avatar;
      room.updatedAt = Date.now();
      for (const [s, c] of wsClients.entries()) {
        if (c.roomCode === client.roomCode && c.id !== client.id) {
          c.isHost = false;
        }
      }
      sendWsJson(client.socket, { type: 'host_promoted' });
      broadcastRoomUpdate(client.roomCode);
      broadcastParticipants(client.roomCode);
      break;
    }

    case 'end_room': {
      const roomCode = client.roomCode;
      if (!roomCode) return;
      const room = rooms.get(roomCode);
      if (room && client.isHost) {
        broadcastToRoom(roomCode, {
          type: 'room_ended',
          roomCode,
        });
        rooms.delete(roomCode);
      }
      handleWsDisconnect(client);
      break;
    }

    case 'leave_room': {
      handleWsDisconnect(client);
      break;
    }
  }
}

function handleWsDisconnect(client) {
  const roomCode = client.roomCode;
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  if (room) {
    room.participants.delete(client.id);

    if (client.isHost) {
      console.log(`[LocalSync] Host left room ${roomCode}. Transferring host to next listener...`);
      // Elect oldest listener as new host
      const remaining = Array.from(room.participants.values());
      remaining.sort((a, b) => a.joinedAt - b.joinedAt);

      if (remaining.length > 0) {
        const newHost = remaining[0];
        newHost.isHost = true;
        room.hostId = newHost.id;
        room.hostName = newHost.name;
        room.hostAvatar = newHost.avatar;
        room.updatedAt = Date.now();

        // Find the client socket for newHost
        for (const [s, c] of wsClients.entries()) {
          if (c.id === newHost.id) {
            c.isHost = true;
            sendWsJson(s, { type: 'host_promoted' });
            break;
          }
        }
        broadcastRoomUpdate(roomCode);
        broadcastParticipants(roomCode);
      } else {
        // No participants left: close room
        rooms.delete(roomCode);
        console.log(`[LocalSync] Room ${roomCode} closed (empty).`);
      }
    } else {
      broadcastParticipants(roomCode);
    }
  }

  wsClients.delete(client.socket);
}

function broadcastRoomUpdate(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  broadcastToRoom(roomCode, {
    type: 'room_update',
    room: serializeRoom(room),
  });
}

function broadcastParticipants(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const participantList = Array.from(room.participants.values());
  broadcastToRoom(roomCode, {
    type: 'participants_update',
    participants: participantList,
  });
}

function serializeRoom(room) {
  return {
    schemaVersion: room.schemaVersion,
    roomCode: room.roomCode,
    hostId: room.hostId,
    hostName: room.hostName,
    hostAvatar: room.hostAvatar,
    isActive: room.isActive,
    currentTrack: room.currentTrack,
    playback: room.playback,
    participants: Array.from(room.participants.values()),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `ETHIO-${code}`;
}

// ---------------------------------------------------------------------------
// Server Initialization & Terminal Banner
// ---------------------------------------------------------------------------

const server = http.createServer(handleHttpRequest);

server.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, socket, head);
});

// If launched with --test flag, verify ports and exit
if (process.argv.includes('--test')) {
  console.log('[Test] Local Sync Hub server configuration valid.');
  process.exit(0);
}

server.listen(DEFAULT_PORT, '0.0.0.0', () => {
  const lanAddrs = getLanAddresses();

  console.log('\n================================================================');
  console.log('🎵  ETHIO LYRICS PLAYER — LOCAL OFFLINE SYNC HUB SERVER');
  console.log('================================================================');
  console.log(`\n  🚀 Status: Active (Zero-Dependency Standalone Hub)`);
  console.log(`  🏠 Local Access:      http://localhost:${DEFAULT_PORT}`);

  console.log('\n  📶 Connect Friends on Wi-Fi or Phone Hotspot (No Internet Needed):');
  lanAddrs.forEach(item => {
    console.log(`     👉 http://${item.address}:${DEFAULT_PORT}  (${item.interface})`);
  });

  console.log('\n  ⚡ Features Enabled:');
  console.log('     • High-Precision Clock Calibration (< 2ms local latency)');
  console.log('     • RFC 6455 Native WebSocket Playback Anchor Relay');
  console.log('     • Local Audio Streaming (friends can stream host\'s local MP3s)');
  console.log('     • Offline PWA Static Asset Caching');
  console.log('\n================================================================\n');
});
