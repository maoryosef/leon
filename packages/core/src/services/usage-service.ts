import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Usage, UsageLimit } from '@leon/shared';
import type { EventBus } from '../events.js';
import { nowIso } from '../util/time.js';

const execFileP = promisify(execFile);

/** Claude Code's own usage endpoint — the same one its status line reads. */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Plan usage (the weekly pools and the 5-hour session pool), polled from the
 * endpoint Claude Code itself uses and pushed to the board's status line.
 *
 * Reads the OAuth token Claude Code already stores — the macOS keychain
 * first, then ~/.claude/.credentials.json. The token is never logged, never
 * persisted by us, and re-read on every poll so a refresh is picked up.
 *
 * The endpoint is undocumented and behind a beta header, so every field is
 * treated as optional: a shape change degrades the status line, it never
 * takes the daemon down.
 */
export class UsageService {
  private timer: NodeJS.Timeout | null = null;
  private latest: Usage | null = null;

  constructor(
    private bus: EventBus,
    private pollMs: number,
  ) {}

  get(): Usage | null {
    return this.latest;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fetch once and publish if anything changed. Never throws. */
  async poll(): Promise<void> {
    const next = await this.fetchUsage();
    if (!next) return;
    const changed =
      this.latest === null ||
      JSON.stringify(this.latest.limits) !== JSON.stringify(next.limits) ||
      this.latest.error !== next.error;
    this.latest = next;
    if (changed) this.bus.emit({ type: 'usage.updated', usage: next });
  }

  private async fetchUsage(): Promise<Usage | null> {
    const token = await this.readToken();
    if (!token) return this.degraded('no Claude Code credentials found');

    try {
      const res = await fetch(USAGE_URL, {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) {
        // 401 usually means the stored token expired; Claude Code refreshes
        // it on its own schedule and the next poll picks the new one up
        return this.degraded(`usage endpoint returned ${res.status}`);
      }
      const limits = toLimits(await res.json());
      if (limits.length === 0) return this.degraded('no limits in the usage response');
      return { limits, fetchedAt: nowIso(), error: null };
    } catch {
      return this.degraded('could not reach the usage endpoint');
    }
  }

  /** Keep the last known limits visible, flagged as stale. */
  private degraded(error: string): Usage {
    return { limits: this.latest?.limits ?? [], fetchedAt: nowIso(), error };
  }

  private async readToken(): Promise<string | null> {
    try {
      const { stdout } = await execFileP(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { timeout: 5000 },
      );
      const token = findAccessToken(JSON.parse(stdout.trim()));
      if (token) return token;
    } catch {
      // no keychain entry, or the daemon was denied access — try the file
    }
    const file = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(file)) return null;
    try {
      return findAccessToken(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return null;
    }
  }
}

/** The credential blob nests differently across versions; search for the key. */
function findAccessToken(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.accessToken === 'string') return record.accessToken;
  for (const nested of Object.values(record)) {
    const found = findAccessToken(nested);
    if (found) return found;
  }
  return null;
}

interface RawLimit {
  kind?: unknown;
  group?: unknown;
  percent?: unknown;
  severity?: unknown;
  resets_at?: unknown;
  scope?: { model?: { display_name?: unknown } | null } | null;
}

/**
 * The response carries the same numbers twice: a `limits` array and loose
 * `five_hour`/`seven_day` objects. The array is the richer one — it names the
 * model a scoped weekly pool belongs to.
 */
function toLimits(payload: unknown): UsageLimit[] {
  const raw = (payload as { limits?: unknown })?.limits;
  if (!Array.isArray(raw)) return [];
  const limits: UsageLimit[] = [];
  for (const entry of raw as RawLimit[]) {
    if (typeof entry?.kind !== 'string' || typeof entry.percent !== 'number') continue;
    const model =
      typeof entry.scope?.model?.display_name === 'string'
        ? entry.scope.model.display_name
        : null;
    limits.push({
      kind: entry.kind,
      group: typeof entry.group === 'string' ? entry.group : null,
      label: labelFor(entry.kind, model),
      percent: Math.max(0, Math.min(100, Math.round(entry.percent))),
      severity:
        entry.severity === 'warning' || entry.severity === 'critical' ? entry.severity : 'normal',
      resetsAt: typeof entry.resets_at === 'string' ? entry.resets_at : null,
    });
  }
  return limits;
}

function labelFor(kind: string, model: string | null): string {
  if (kind === 'weekly_scoped') return model ? `${model} weekly` : 'model weekly';
  if (kind === 'weekly_all') return 'weekly';
  if (kind === 'session') return 'session';
  return kind.replace(/_/g, ' ');
}
