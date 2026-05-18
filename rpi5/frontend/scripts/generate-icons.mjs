/**
 * Genera le icone PWA dal logo SVG dell'identità Orto Digitale.
 * - icon-192.png       (192x192, fit fullbleed)
 * - icon-512.png       (512x512, fit fullbleed)
 * - icon-512-maskable.png (512x512, contenuto entro safe zone ~80%, sfondo opaco)
 *
 * Palette: paper #f4efe6, moss #5b6f47, terra #a05e44.
 */
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../public/icons');

const PAPER = '#f4efe6';
const MOSS = '#5b6f47';
const TERRA = '#a05e44';

/** SVG full-bleed: foglia stilizzata + goccia, occupa ~95% del canvas. */
function buildFullBleedSvg(size) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <rect width="512" height="512" fill="${PAPER}"/>
  <g transform="translate(256 256)">
    <!-- foglia -->
    <path d="M -130 60 C -130 -60, -40 -150, 110 -130 C 130 20, 50 130, -110 130 C -130 110, -130 80, -130 60 Z"
          fill="${MOSS}"/>
    <!-- nervatura centrale -->
    <path d="M -110 110 C -40 40, 40 -40, 100 -120"
          stroke="${PAPER}" stroke-width="6" stroke-linecap="round" fill="none" opacity="0.85"/>
    <!-- nervature laterali -->
    <path d="M -60 80 C -30 60, 0 40, 30 10"
          stroke="${PAPER}" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.7"/>
    <path d="M -30 100 C 0 80, 30 60, 60 30"
          stroke="${PAPER}" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.7"/>
    <!-- goccia -->
    <path d="M 90 -10 C 90 30, 60 50, 50 50 C 40 50, 10 30, 10 -10 C 10 -40, 50 -80, 50 -80 C 50 -80, 90 -40, 90 -10 Z"
          fill="${TERRA}"/>
    <!-- highlight goccia -->
    <ellipse cx="35" cy="-20" rx="6" ry="14" fill="${PAPER}" opacity="0.55"/>
  </g>
</svg>`;
}

/** SVG maskable: stesso contenuto ma scalato all'80% (safe zone), su sfondo paper opaco. */
function buildMaskableSvg(size) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <rect width="512" height="512" fill="${PAPER}"/>
  <g transform="translate(256 256) scale(0.78)">
    <path d="M -130 60 C -130 -60, -40 -150, 110 -130 C 130 20, 50 130, -110 130 C -130 110, -130 80, -130 60 Z"
          fill="${MOSS}"/>
    <path d="M -110 110 C -40 40, 40 -40, 100 -120"
          stroke="${PAPER}" stroke-width="6" stroke-linecap="round" fill="none" opacity="0.85"/>
    <path d="M -60 80 C -30 60, 0 40, 30 10"
          stroke="${PAPER}" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.7"/>
    <path d="M -30 100 C 0 80, 30 60, 60 30"
          stroke="${PAPER}" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.7"/>
    <path d="M 90 -10 C 90 30, 60 50, 50 50 C 40 50, 10 30, 10 -10 C 10 -40, 50 -80, 50 -80 C 50 -80, 90 -40, 90 -10 Z"
          fill="${TERRA}"/>
    <ellipse cx="35" cy="-20" rx="6" ry="14" fill="${PAPER}" opacity="0.55"/>
  </g>
</svg>`;
}

async function renderToPng(svg, size, outName) {
  const buf = Buffer.from(svg, 'utf8');
  await sharp(buf, { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(path.join(outDir, outName));
  console.log('  ✓', outName);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  console.log('Generating PWA icons →', outDir);
  await renderToPng(buildFullBleedSvg(192), 192, 'icon-192.png');
  await renderToPng(buildFullBleedSvg(512), 512, 'icon-512.png');
  await renderToPng(buildMaskableSvg(512), 512, 'icon-512-maskable.png');
  // Save source SVG too for future regeneration
  await writeFile(path.join(outDir, 'icon.svg'), buildFullBleedSvg(512), 'utf8');
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
