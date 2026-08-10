#!/usr/bin/env electron
/**
 * Builds the app icon from the avatar (packages/web/public/leon.png), shaped
 * to Apple's macOS template so it sits naturally beside Chrome and Slack:
 *
 *   1024x1024 canvas, 824x824 body centred in it (the 100px margin is what
 *   keeps every dock icon optically the same size), the body masked to the
 *   squircle, and a soft drop shadow baked in — macOS does not add one.
 *
 * Output:
 *   build/icon.png   — the 1024 master (dock icon for a dev run, linux/win)
 *   build/icon.icns  — the macOS bundle icon
 *
 * Run through Electron rather than node: nativeImage is the only image codec
 * in the toolchain, and this needs raw pixels to mask and blur them.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, nativeImage } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const source = join(repo, 'packages', 'web', 'public', 'leon.png');
const build = join(here, '..', 'build');

const CANVAS = 1024;
const BODY = 824; // Apple's icon grid: 824 of 1024, i.e. a 100px margin
const MARGIN = (CANVAS - BODY) / 2;

/** Superellipse exponent that approximates macOS's continuous corners. */
const SQUIRCLE_N = 5;
const SAMPLES = 4; // per axis, so 16 coverage samples per pixel

const SHADOW = { offsetY: 10, blur: 6, opacity: 0.28 };

/**
 * The avatar is framed for a 22px header chip, where the surrounding room
 * reads fine; in a dock tile it leaves the face small. Crop in on the face
 * for the icon only — leon.png itself is untouched. FOCUS is the face centre
 * in normalised coordinates, ZOOM how tightly to crop (1 = the whole image).
 */
const FOCUS = { x: 0.52, y: 0.48 };
const ZOOM = 1.15;

/** The face-centred square of the source, clamped to its bounds. */
function cropRect(width, height) {
  const side = Math.round(Math.min(width, height) / ZOOM);
  const clamp = (value, max) => Math.max(0, Math.min(max - side, Math.round(value)));
  return {
    x: clamp(FOCUS.x * width - side / 2, width),
    y: clamp(FOCUS.y * height - side / 2, height),
    width: side,
    height: side,
  };
}

/** Coverage of the squircle over one body pixel, antialiased by supersampling. */
function coverage(px, py) {
  let hits = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      // normalise the sample to [-1, 1] across the body
      const u = ((px + (sx + 0.5) / SAMPLES) / BODY) * 2 - 1;
      const v = ((py + (sy + 0.5) / SAMPLES) / BODY) * 2 - 1;
      if (Math.abs(u) ** SQUIRCLE_N + Math.abs(v) ** SQUIRCLE_N <= 1) hits++;
    }
  }
  return hits / (SAMPLES * SAMPLES);
}

/** Separable box blur, run three times — close enough to a gaussian. */
function blur(field, size, radius) {
  const pass = (input) => {
    const output = new Float32Array(input.length);
    const width = 2 * radius + 1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        for (let d = -radius; d <= radius; d++) {
          const sx = Math.min(size - 1, Math.max(0, x + d));
          sum += input[y * size + sx];
        }
        output[y * size + x] = sum / width;
      }
    }
    // transpose so the same loop blurs the other axis on the next call
    const transposed = new Float32Array(input.length);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) transposed[x * size + y] = output[y * size + x];
    }
    return transposed;
  };
  let current = field;
  for (let i = 0; i < 6; i++) current = pass(current); // 3 blurs x 2 axes
  return current;
}

function buildMaster() {
  const original = nativeImage.createFromPath(source);
  const { width, height } = original.getSize();
  const avatar = original
    .crop(cropRect(width, height))
    .resize({ width: BODY, height: BODY, quality: 'best' });
  const body = avatar.toBitmap(); // 4 bytes per pixel; alpha is byte 3

  // 1. squircle coverage for every body pixel
  const mask = new Float32Array(BODY * BODY);
  for (let y = 0; y < BODY; y++) {
    for (let x = 0; x < BODY; x++) mask[y * BODY + x] = coverage(x, y);
  }

  // 2. the shadow: the same silhouette, dropped down and blurred
  const shadowField = new Float32Array(CANVAS * CANVAS);
  for (let y = 0; y < BODY; y++) {
    for (let x = 0; x < BODY; x++) {
      const cy = y + MARGIN + SHADOW.offsetY;
      const cx = x + MARGIN;
      if (cy >= 0 && cy < CANVAS) shadowField[cy * CANVAS + cx] = mask[y * BODY + x];
    }
  }
  const shadow = blur(shadowField, CANVAS, SHADOW.blur);

  // 3. compose: shadow first, then the masked body over it
  const canvas = Buffer.alloc(CANVAS * CANVAS * 4);
  for (let i = 0; i < CANVAS * CANVAS; i++) {
    const alpha = Math.min(1, shadow[i] * SHADOW.opacity);
    canvas[i * 4 + 3] = Math.round(alpha * 255); // black shadow: RGB stays 0
  }
  for (let y = 0; y < BODY; y++) {
    for (let x = 0; x < BODY; x++) {
      const src = (y * BODY + x) * 4;
      const dst = ((y + MARGIN) * CANVAS + (x + MARGIN)) * 4;
      const a = mask[y * BODY + x];
      if (a <= 0) continue;
      const under = canvas[dst + 3] / 255;
      const out = a + under * (1 - a);
      for (let c = 0; c < 3; c++) {
        // premultiplied "over"; the shadow's colour is black, so it drops out
        canvas[dst + c] = Math.round((body[src + c] * a) / out);
      }
      canvas[dst + 3] = Math.round(out * 255);
    }
  }

  return nativeImage.createFromBitmap(canvas, { width: CANVAS, height: CANVAS });
}

function main() {
  mkdirSync(build, { recursive: true });
  const master = buildMaster();
  const icon = join(build, 'icon.png');
  writeFileSync(icon, master.toPNG());

  if (process.platform !== 'darwin') {
    console.log('wrote build/icon.png (icns needs macOS)');
    return;
  }

  const iconset = join(build, 'leon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [
      [1, ''],
      [2, '@2x'],
    ]) {
      const pixels = size * scale;
      const resized = master.resize({ width: pixels, height: pixels, quality: 'best' });
      writeFileSync(join(iconset, `icon_${size}x${size}${suffix}.png`), resized.toPNG());
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(build, 'icon.icns')], {
    stdio: 'inherit',
  });
  rmSync(iconset, { recursive: true, force: true });
  console.log('wrote build/icon.png and build/icon.icns');
}

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  app.dock?.hide(); // it is a build step, not an app
  try {
    main();
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
