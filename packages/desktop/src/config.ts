import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

export interface DesktopConfig {
  host: string;
  port: number;
  token: string;
  dataDir: string;
  configPath: string;
  /** where the board lives: http://host:port */
  baseUrl: string;
}

/**
 * Reads ~/.leon/config.toml directly rather than importing @leon/core — the
 * core package pulls in better-sqlite3, and a native module loaded inside
 * Electron would need a rebuild against Electron's ABI. The desktop shell
 * stays pure JS; the daemon child process keeps the native deps.
 */
export function readConfig(): DesktopConfig | null {
  const dataDir = process.env.LEON_DATA_DIR ?? join(homedir(), '.leon');
  const configPath = join(dataDir, 'config.toml');
  if (!existsSync(configPath)) return null;

  const raw = parse(readFileSync(configPath, 'utf8')) as {
    server?: { host?: string; port?: number; token?: string };
  };
  const token = raw.server?.token;
  if (typeof token !== 'string' || token.length < 16) return null;

  const host = raw.server?.host ?? '127.0.0.1';
  const port = raw.server?.port ?? 5366;
  return { host, port, token, dataDir, configPath, baseUrl: `http://${host}:${port}` };
}
