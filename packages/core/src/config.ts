import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';

const ConfigSchema = z.object({
  // server is always present: loadConfig injects a token before parsing
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().default(5366),
    token: z.string().min(16),
  }),
  discovery: z
    .object({
      pollMs: z.number().int().default(2000),
      scrapeMs: z.number().int().default(5000),
      prPollMs: z.number().int().default(60_000),
    })
    .prefault({}),
  personality: z
    .object({
      promptFile: z.string().default('~/.leon/personalities/leon-black.md'),
    })
    .prefault({}),
  agent: z
    .object({
      model: z.string().default('sonnet'),
    })
    .prefault({}),
  notifications: z
    .object({
      desktop: z.boolean().default(true), // macOS toast via osascript
      chat: z.boolean().default(true), // Leon comments proactively in chat
    })
    .prefault({}),
});

export type LeonConfig = z.infer<typeof ConfigSchema> & {
  dataDir: string;
  dbPath: string;
  configPath: string;
};

export function leonDataDir(): string {
  return process.env.LEON_DATA_DIR ?? join(homedir(), '.leon');
}

/**
 * Loads ~/.leon/config.toml, creating it (with a fresh random bearer token,
 * mode 0600) on first run.
 */
export function loadConfig(): LeonConfig {
  const dataDir = leonDataDir();
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(dataDir, 'config.toml');

  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    raw = parse(readFileSync(configPath, 'utf8'));
  }

  const server = (raw.server ?? {}) as Record<string, unknown>;
  let dirty = false;
  if (typeof server.token !== 'string' || server.token.length < 16) {
    server.token = randomBytes(24).toString('hex');
    raw.server = server;
    dirty = true;
  }

  const parsed = ConfigSchema.parse(raw);
  if (dirty || !existsSync(configPath)) {
    writeFileSync(configPath, stringify(parsed), { mode: 0o600 });
  }

  return {
    ...parsed,
    dataDir,
    dbPath: join(dataDir, 'leon.db'),
    configPath,
  };
}

export function expandTilde(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}
