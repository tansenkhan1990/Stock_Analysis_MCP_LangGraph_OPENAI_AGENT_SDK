import { badRequest } from '../lib/errors.js';

/**
 * Images are sent to the model inline (base64) rather than stored on disk:
 * one chart or broker screenshot is enough to answer the question, and the
 * in-memory thread store keeps the last one for follow-ups.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Canonical MIME types the vision endpoints accept. */
const MIME_TYPES = new Map([
  ['image/png', 'image/png'],
  ['image/jpeg', 'image/jpeg'],
  ['image/jpg', 'image/jpeg'],
  ['image/webp', 'image/webp'],
  ['image/gif', 'image/gif'],
]);

const DATA_URL = /^data:([^;,]+);base64,([\s\S]*)$/i;

/** Accept either raw base64 or a `data:image/png;base64,…` URL. */
export function parseImageAttachment(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('The attached image is invalid.');

  const fileName =
    typeof raw.fileName === 'string' && raw.fileName.trim() ? raw.fileName.trim().slice(0, 120) : 'image.png';
  let mimeType = typeof raw.mimeType === 'string' ? raw.mimeType.trim().toLowerCase() : '';
  let data = typeof raw.data === 'string' ? raw.data.trim() : '';

  const dataUrl = data.match(DATA_URL);
  if (dataUrl) {
    mimeType = mimeType || dataUrl[1].toLowerCase();
    data = dataUrl[2];
  }

  const canonical = MIME_TYPES.get(mimeType);
  if (!canonical) throw badRequest('Unsupported image type. Use a PNG, JPEG, WebP or GIF image.');
  data = data.replace(/\s+/g, '');
  if (!data) throw badRequest('The attached image is empty.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw badRequest('The attached image is not valid base64 data.');

  const bytes = Buffer.byteLength(data, 'base64');
  if (!bytes) throw badRequest('The attached image is empty.');
  if (bytes > MAX_IMAGE_BYTES) {
    throw badRequest(`Image is too large (max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB).`);
  }

  return { fileName, mimeType: canonical, data, bytes };
}

/** One text block plus the image, in the internal multi-part message shape. */
export function imageMessage(text, image) {
  if (!image) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', mimeType: image.mimeType, data: image.data },
    ],
  };
}
