#!/usr/bin/env node
/**
 * Runs the desktop app in dev — through a bundle actually called Leon.app.
 *
 * `electron dist/main.js` launches Electron's own bundle, and macOS labels an
 * app in the Dock and the ⌘-Tab switcher by its bundle *directory name*:
 * "Electron.app" reads as "Electron" no matter what CFBundleName says, and
 * app.setName() can't reach it either. So keep a branded copy of the bundle
 * next to the build and launch that instead. The copy is ~250MB, made once
 * and refreshed only when Electron or the icon changes.
 *
 * The executable inside keeps its original name, which leaves the bundle's
 * signature intact — the cost is that `ps` still says Electron. Only the
 * packaged app (`pnpm desktop:dist`) gets a binary named Leon too.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'Leon';
const BUNDLE_ID = 'ai.accomplish.leon.dev';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const entry = join(desktop, 'dist', 'main.js');
const require = createRequire(import.meta.url);
const electronBinary = require('electron');

/** Launch the stock bundle: nothing below applies off macOS. */
function runStock() {
  const child = spawn(electronBinary, [entry], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

if (process.platform !== 'darwin' || typeof electronBinary !== 'string') {
  runStock();
} else {
  const source = join(dirname(electronBinary), '..', '..'); // …/Electron.app
  const bundle = join(desktop, '.devapp', `${NAME}.app`);
  const plist = join(bundle, 'Contents', 'Info.plist');
  const icns = join(desktop, 'build', 'icon.icns');
  const stampFile = join(bundle, 'Contents', 'Resources', '.leon-dev');

  const version = JSON.parse(
    readFileSync(require.resolve('electron/package.json'), 'utf8'),
  ).version;
  const stamp = `${version} ${existsSync(icns) ? statSync(icns).mtimeMs : 0}`;
  const current = existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : null;

  if (current !== stamp) {
    console.log(`[leon] building the dev app bundle (electron ${version})…`);
    rmSync(bundle, { recursive: true, force: true });
    mkdirSync(dirname(bundle), { recursive: true });
    // ditto keeps symlinks, permissions and the nested code signatures intact
    execFileSync('ditto', [source, bundle]);

    const read = (key) => {
      try {
        return execFileSync('plutil', ['-extract', key, 'raw', plist], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return null;
      }
    };
    const set = (key, value) =>
      execFileSync('plutil', [
        read(key) === null ? '-insert' : '-replace',
        key,
        '-string',
        value,
        plist,
      ]);

    set('CFBundleName', NAME);
    set('CFBundleDisplayName', NAME);
    // its own id, so it never inherits the name macOS cached for com.github.Electron
    set('CFBundleIdentifier', BUNDLE_ID);
    if (existsSync(icns)) {
      execFileSync('cp', [icns, join(bundle, 'Contents', 'Resources', 'icon.icns')]);
      set('CFBundleIconFile', 'icon');
    }

    writeFileSync(stampFile, stamp);
    try {
      const lsregister =
        '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
      if (existsSync(lsregister)) execFileSync(lsregister, ['-f', bundle], { stdio: 'ignore' });
    } catch {
      // best effort; the name applies on the next launch either way
    }
    console.log(`[leon] dev app bundle ready — ${bundle}`);
  }

  const binary = join(bundle, 'Contents', 'MacOS', 'Electron');
  if (!existsSync(binary)) {
    console.error(`[leon] ${binary} is missing — falling back to the stock bundle`);
    runStock();
  } else {
    const child = spawn(binary, [entry], { stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => child.kill(signal));
    }
    child.on('exit', (code) => process.exit(code ?? 0));
  }
}
