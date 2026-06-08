// scripts/seed-rating-photos.js
// Seeds the rating_photos pool from local image files. Run with:
//   npm run seed:rating-photos
// Re-running CLEARS the existing pool and re-inserts from disk, so it's the one
// place you manage the v1 photo set. (It does NOT touch sessions or scores.)
//
// WHERE THE IMAGES LIVE:
//   public/rate/pool/male/*.{jpg,jpeg,png,webp}
//   public/rate/pool/female/*
//   public/rate/pool/nonbinary/*
// Each file becomes one row with url = /rate/pool/{bucket}/{filename}, served
// as a static asset. position follows sorted filename order within a bucket, so
// name them 01.jpg, 02.jpg, ... to control order.
//
// SWITCHING TO R2 LATER: replace the url we store (the `/rate/pool/...` path)
// with the photo's R2 public URL. Nothing else in the feature cares where the
// images are hosted - it just stores and renders whatever url is here.

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import { uploadPoolPhoto, r2Configured } from '../src/lib/r2.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POOL_DIR = join(__dirname, '..', 'public', 'rate', 'pool');
const BUCKETS = ['male', 'female', 'nonbinary'];
const IMAGE_RE = /\.(jpe?g|png|webp)$/i;

function filesFor(bucket) {
  const dir = join(POOL_DIR, bucket);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => IMAGE_RE.test(f) && !f.startsWith('.'))
    .sort(); // 01.jpg, 02.jpg, ... -> stable position order
}

async function main() {
  // Build the full insert list from disk first, so we don't wipe the pool if
  // the folders are empty (which would otherwise leave nothing to rate).
  const useR2 = r2Configured();
  console.log(useR2
    ? 'R2 configured -> uploading pool images to R2 and storing their public URLs.'
    : 'R2 not configured -> storing local /rate/pool/... paths (dev/static mode).');

  const CT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  const rows = [];
  for (const bucket of BUCKETS) {
    const files = filesFor(bucket);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      let url;
      if (useR2) {
        // Upload the file to R2 under pool/{bucket}/{file}; store its public URL.
        const ext = (file.split('.').pop() || 'jpg').toLowerCase();
        const buffer = readFileSync(join(POOL_DIR, bucket, file));
        url = await uploadPoolPhoto(bucket, file, buffer, CT[ext] || 'image/jpeg');
      } else {
        url = `/rate/pool/${bucket}/${file}`;
      }
      rows.push({ bucket, url, position: i + 1 });
    }
    console.log(`${bucket}: found ${files.length} image(s)`);
  }

  if (rows.length === 0) {
    console.error(
      `\nNo images found under ${POOL_DIR}.\n` +
      `Create the folders and add images, e.g.:\n` +
      `  public/rate/pool/female/01.jpg, 02.jpg, ...\n` +
      `  public/rate/pool/male/01.jpg, ...\n` +
      `  public/rate/pool/nonbinary/01.jpg, ...\n` +
      `then re-run: npm run seed:rating-photos\n`
    );
    await pool.end();
    process.exit(1);
  }

  // Clean re-seed of the pool. We delete only photos NOT referenced by an
  // existing session's frozen list (those are protected by the FK from
  // rating_session_photos). In a fresh dev DB nothing references them, so the
  // pool clears fully; if a session already froze some, we keep those rows and
  // upsert is avoided to respect the frozen lists.
  const used = await pool.query('SELECT DISTINCT photo_id FROM rating_session_photos');
  const usedCount = used.rows.length;
  if (usedCount > 0) {
    console.log(`note: ${usedCount} photo(s) are referenced by existing sessions and will be left as-is.`);
    await pool.query(
      `DELETE FROM rating_photos
        WHERE id NOT IN (SELECT photo_id FROM rating_session_photos)`
    );
  } else {
    await pool.query('DELETE FROM rating_photos');
  }

  let inserted = 0;
  for (const r of rows) {
    // Avoid duplicating a url that a session already froze (kept above).
    const exists = await pool.query(
      'SELECT 1 FROM rating_photos WHERE gender_bucket = $1 AND url = $2',
      [r.bucket, r.url]
    );
    if (exists.rows.length > 0) continue;
    await pool.query(
      `INSERT INTO rating_photos (gender_bucket, url, position, is_active)
       VALUES ($1, $2, $3, true)`,
      [r.bucket, r.url, r.position]
    );
    inserted++;
  }

  console.log(`\nSeeded ${inserted} photo(s) into rating_photos.`);
  await pool.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Rating-photo seeding failed:', err.message);
  process.exit(1);
});
