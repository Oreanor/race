// Builds public/textures/foliage.webp from docs/leaves.jpeg: the leaves' shading as data, not
// colour (a tree's own tint colours it, any season).
// One grey channel: leaf light and shade, centred on 0.5 (the photo's mean brightness).
// The crown's warmer and cooler patches are noise in the shader.
// Made seamless (the photo blended with itself shifted half a tile) and 512 px.
// Run: node scripts/foliage-texture.mjs
import sharp from 'sharp';

const SIZE = 512;
const src = await sharp('docs/leaves.jpeg').resize(SIZE, SIZE).removeAlpha().raw().toBuffer();
const lum = new Float32Array(SIZE * SIZE);
for (let i = 0; i < SIZE * SIZE; i++) lum[i] = (0.2126 * src[i * 3] + 0.7152 * src[i * 3 + 1] + 0.0722 * src[i * 3 + 2]) / 255;

// seamless: the edges come from the copy shifted half a tile, whose edges were the middle
const half = SIZE / 2;
const tile = new Float32Array(SIZE * SIZE);
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
  const shifted = lum[((y + half) % SIZE) * SIZE + (x + half) % SIZE];
  const ex = Math.min(x, SIZE - 1 - x) / half, ey = Math.min(y, SIZE - 1 - y) / half;
  // blend only a narrow band along the edges (a wide one doubled every leaf)
  const m = Math.min(1, Math.min(ex, ey) * 6);
  const w = m * m * (3 - 2 * m);
  tile[y * SIZE + x] = lum[y * SIZE + x] * w + shifted * (1 - w);
}

// R: around the mean, stretched to use the range
let mean = 0;
for (const v of tile) mean += v;
mean /= tile.length;
let dev = 0;
for (const v of tile) dev += (v - mean) ** 2;
dev = Math.sqrt(dev / tile.length);

const out = Buffer.alloc(SIZE * SIZE);
for (let i = 0; i < SIZE * SIZE; i++) out[i] = Math.round(Math.max(0, Math.min(1, 0.5 + (tile[i] - mean) / dev * 0.17)) * 255);
// one grey channel (lossy colour formats would bleed other channels into it)
await sharp(out, { raw: { width: SIZE, height: SIZE, channels: 1 } }).toColourspace('b-w').webp({ quality: 88 }).toFile('public/textures/foliage.webp');
console.log('public/textures/foliage.webp', SIZE, 'mean', mean.toFixed(3), 'dev', dev.toFixed(3));
