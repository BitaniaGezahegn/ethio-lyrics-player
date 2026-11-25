/**
 * Cloudflare Pages Function: Authenticated Media Upload to R2
 * Route: POST /api/upload
 *
 * Requires Cloudflare Pages R2 bucket binding named `MEDIA_BUCKET`
 * (Cloudflare Dashboard -> Pages -> ethio-lyrics-player -> Settings -> Functions -> R2 bucket bindings).
 */

const FIREBASE_PROJECT_ID = 'ethio-lyrics-player';
const ADMIN_EMAIL = 'bitaniagezahegn3@gmail.com';
const R2_PUBLIC_BASE = 'https://pub-be2150892c704dc9b69b81b3d76f7984.r2.dev';
const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;  // 5 MB

// Cache Google public certs briefly per edge isolate
let cachedCerts = null;
let certsExpiresAt = 0;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

function base64UrlToUint8Array(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Use Google securetoken JWK endpoint for RS256 Firebase ID token verification
async function getGoogleJwks() {
  const now = Date.now();
  if (cachedCerts && now < certsExpiresAt) return cachedCerts;
  const res = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
  );
  if (!res.ok) throw new Error('Failed to fetch Firebase token verification keys');
  const cc = res.headers.get('cache-control') || '';
  const maxAgeMatch = cc.match(/max-age=(\d+)/);
  const maxAgeMs = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) * 1000 : 300000;
  const data = await res.json();
  cachedCerts = data.keys || [];
  certsExpiresAt = now + maxAgeMs;
  return cachedCerts;
}

async function verifyFirebaseIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(payloadB64)));

  if (header.alg !== 'RS256' || !header.kid) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= nowSec) return null;
  if (payload.aud !== FIREBASE_PROJECT_ID) return null;
  if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) return null;
  if (!payload.sub) return null;

  const jwks = await getGoogleJwks();
  const jwk = jwks.find(k => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signedBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigBytes = base64UrlToUint8Array(sigB64);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, signedBytes);
  return valid ? payload : null;
}

function sanitizeFileName(name, fallbackExt = 'mp3') {
  const cleaned = String(name || `track.${fallbackExt}`)
    .normalize('NFKD')
    .replace(/[^\w.\-()\u1200-\u137F]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || `upload_${Date.now()}.${fallbackExt}`;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env || !env.MEDIA_BUCKET) {
    return jsonResponse({
      error: 'R2 bucket binding "MEDIA_BUCKET" is not configured on Cloudflare Pages. Add it in Pages > Settings > Functions > R2 bucket bindings.'
    }, 503);
  }

  // Verify Firebase Auth Bearer token
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  let decodedUser = null;
  try {
    decodedUser = await verifyFirebaseIdToken(token);
  } catch (err) {
    return jsonResponse({ error: 'Authentication verification failed: ' + err.message }, 401);
  }
  if (!decodedUser) {
    return jsonResponse({ error: 'Please sign in with Google before uploading to the Global Catalog.' }, 401);
  }

  const contentType = request.headers.get('Content-Type') || '';

  // Optional POST delete action fallback
  if (contentType.includes('application/json')) {
    try {
      const cloned = request.clone();
      const body = await cloned.json();
      if (body && body.action === 'delete') {
        return onRequestDelete(context);
      }
    } catch (e) {}
  }

  let fileBuffer = null;
  let fileMime = 'audio/mpeg';
  let originalName = 'track.mp3';
  let kind = (request.headers.get('X-Upload-Kind') || 'audio').toLowerCase();

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      if (!file || typeof file.arrayBuffer !== 'function') {
        return jsonResponse({ error: 'Missing file in form data.' }, 400);
      }
      kind = String(form.get('kind') || kind).toLowerCase();
      originalName = file.name || originalName;
      fileMime = file.type || fileMime;
      fileBuffer = await file.arrayBuffer();
    } else {
      originalName = decodeURIComponent(request.headers.get('X-File-Name') || originalName);
      fileMime = contentType || fileMime;
      fileBuffer = await request.arrayBuffer();
    }
  } catch (err) {
    return jsonResponse({ error: 'Failed to read upload payload: ' + err.message }, 400);
  }

  if (!fileBuffer || fileBuffer.byteLength === 0) {
    return jsonResponse({ error: 'Empty upload payload.' }, 400);
  }

  const isCover = kind === 'cover';
  const maxBytes = isCover ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
  if (fileBuffer.byteLength > maxBytes) {
    return jsonResponse({
      error: `File too large (${Math.round(fileBuffer.byteLength / (1024 * 1024))}MB). Max allowed is ${Math.round(maxBytes / (1024 * 1024))}MB.`
    }, 413);
  }

  if (isCover && !fileMime.startsWith('image/')) {
    return jsonResponse({ error: 'Cover upload must be an image file.' }, 400);
  }
  if (!isCover && !fileMime.startsWith('audio/') && !/\.(mp3|m4a|wav|ogg|aac|flac)$/i.test(originalName)) {
    return jsonResponse({ error: 'Track upload must be an audio file.' }, 400);
  }

  const folder = isCover ? 'covers' : 'tracks';
  const safeName = sanitizeFileName(originalName, isCover ? 'jpg' : 'mp3');
  const key = `${folder}/${Date.now()}_${safeName}`;

  await env.MEDIA_BUCKET.put(key, fileBuffer, {
    httpMetadata: {
      contentType: fileMime,
      cacheControl: 'public, max-age=31536000'
    },
    customMetadata: {
      uploadedBy: decodedUser.email || decodedUser.sub || 'user'
    }
  });

  const publicUrl = `${R2_PUBLIC_BASE}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
  return jsonResponse({
    ok: true,
    key,
    url: publicUrl,
    size: fileBuffer.byteLength,
    contentType: fileMime
  }, 200);
}

export async function onRequestDelete(context) {
  const { request, env } = context;

  if (!env || !env.MEDIA_BUCKET) {
    return jsonResponse({
      error: 'R2 bucket binding "MEDIA_BUCKET" is not configured on Cloudflare Pages.'
    }, 503);
  }

  // Verify Firebase Auth Bearer token
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  let decodedUser = null;
  try {
    decodedUser = await verifyFirebaseIdToken(token);
  } catch (err) {
    return jsonResponse({ error: 'Authentication verification failed: ' + err.message }, 401);
  }
  if (!decodedUser || !decodedUser.email) {
    return jsonResponse({ error: 'Please sign in with Google before deleting media from R2.' }, 401);
  }

  const userEmail = String(decodedUser.email).trim().toLowerCase();
  if (userEmail !== ADMIN_EMAIL.toLowerCase()) {
    return jsonResponse({ error: 'Unauthorized: Only the admin can delete media from Cloudflare R2.' }, 403);
  }

  let items = [];
  try {
    const contentType = request.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      const body = await request.json();
      if (Array.isArray(body.keys)) items.push(...body.keys);
      if (Array.isArray(body.urls)) items.push(...body.urls);
      if (body.key && typeof body.key === 'string') items.push(body.key);
      if (body.url && typeof body.url === 'string') items.push(body.url);
    }
  } catch (e) {}

  if (items.length === 0) {
    try {
      const urlObj = new URL(request.url);
      const qKey = urlObj.searchParams.get('key');
      const qUrl = urlObj.searchParams.get('url');
      if (qKey) items.push(qKey);
      if (qUrl) items.push(qUrl);
    } catch (e) {}
  }

  if (items.length === 0) {
    return jsonResponse({ error: 'No keys or URLs provided for deletion.' }, 400);
  }

  const keysToDelete = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'string') continue;
    let clean = item.trim();
    if (clean.startsWith('http://') || clean.startsWith('https://')) {
      try {
        const parsed = new URL(clean);
        clean = parsed.pathname.replace(/^\/+/, '');
      } catch (e) {
        continue;
      }
    }
    if (clean) {
      keysToDelete.add(clean);
      try {
        const decoded = decodeURIComponent(clean);
        if (decoded) keysToDelete.add(decoded);
      } catch (e) {}
    }
  }

  const deleted = [];
  for (const k of keysToDelete) {
    try {
      await env.MEDIA_BUCKET.delete(k);
      deleted.push(k);
    } catch (delErr) {
      console.warn('R2 delete error for key', k, delErr);
    }
  }

  return jsonResponse({
    ok: true,
    deleted
  }, 200);
}
