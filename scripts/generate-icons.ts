// Renders the app icons in public/ from the receipt glyph (same drawing as public/favicon.svg).
// Run: npm run icons
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const BG = '#2f5fd0';
const FG = '#fafaf8';
// The glyph on a 64-unit grid, without the rounded tile: a receipt with a medical cross.
const glyph = `<g fill="none" stroke="${FG}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 12h28v40l-4.7-3-4.6 3-4.7-3-4.7 3-4.6-3L18 52z"/><path d="M32 22v12M26 28h12"/><path d="M25 42h14"/></g>`;

/** Full-bleed square with the glyph scaled into the middle `scale` of the tile. */
function svg(scale: number): string {
  const offset = (64 - 64 * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${BG}"/><g transform="translate(${offset} ${offset}) scale(${scale})">${glyph}</g></svg>`;
}

const out = new URL('../public/', import.meta.url);
const jobs: [string, number, number][] = [
  ['pwa-192x192.png', 192, 1],
  ['pwa-512x512.png', 512, 1],
  ['maskable-512x512.png', 512, 0.72], // keeps the glyph inside the maskable safe zone
  ['apple-touch-icon.png', 180, 0.92],
];
for (const [name, size, scale] of jobs) {
  const png = await sharp(Buffer.from(svg(scale)))
    .resize(size, size)
    .png()
    .toBuffer();
  writeFileSync(new URL(name, out), png);
  console.log(`public/${name}`);
}
