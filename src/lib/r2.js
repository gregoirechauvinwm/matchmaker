// src/lib/r2.js
// Thin wrapper over the S3-compatible Cloudflare R2 API. Uploads an image
// buffer and returns its public URL.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const accountId = process.env.R2_ACCOUNT_ID;
const bucket = process.env.R2_BUCKET;
const publicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

// One client, reused. R2's endpoint is derived from the account id.
const client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Decode a data URL (data:image/jpeg;base64,...) into { buffer, contentType }.
export function decodeDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return null;
  return { contentType: m[1], buffer: Buffer.from(m[2], 'base64') };
}

function extFor(contentType) {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/heic') return 'heic';
  return 'jpg';
}

// Upload an image buffer under users/{userId}/ and return its public URL.
export async function uploadUserPhoto(userId, dataUrl) {
  const decoded = decodeDataUrl(dataUrl);
  if (!decoded) throw new Error('invalid_data_url');
  const key = `users/${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extFor(decoded.contentType)}`;
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: decoded.buffer,
    ContentType: decoded.contentType,
  }));
  return `${publicUrl}/${key}`;
}

export function r2Configured() {
  return !!(accountId && bucket && publicUrl && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}
