/**
 * HTML & URL sanitization utilities to prevent XSS from remote/user metadata.
 */

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeUrl(url, fallback = 'brand/elm-default-cover.svg') {
  if (!url || typeof url !== 'string') return fallback;
  const trimmed = url.trim();
  if (!trimmed) return fallback;

  // Allow safe HTTP(S), Blob URLs, and base64 raster image Data URLs
  if (/^(https?:\/\/|blob:|data:image\/(png|jpeg|jpg|webp|gif|bmp|ico);base64,)/i.test(trimmed)) {
    return trimmed;
  }

  // Allow safe relative local asset/brand paths (disallow '..' traversal)
  if (/^\.?\/?(assets|brand)\/[a-zA-Z0-9_./-]+$/i.test(trimmed) && !trimmed.includes('..')) {
    return trimmed;
  }

  return fallback;
}
