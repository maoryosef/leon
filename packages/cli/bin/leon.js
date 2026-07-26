#!/usr/bin/env node
// Thin launcher: runs the TS CLI through tsx so no build step is needed.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');
const entry = join(here, '..', 'src', 'index.ts');

const res = spawnSync(process.execPath, [tsx, entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
