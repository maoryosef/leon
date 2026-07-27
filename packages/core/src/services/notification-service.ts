import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { PullRequest, Session, SessionStatus, WsEvent } from '@leon/shared';
import type { LeonConfig } from '../config.js';
import type { EventBus } from '../events.js';

const execFileP = promisify(execFile);

/** AppleScript for the Leon.app notifier applet: reads the message from
 * ~/.leon/notify.txt and posts it — attributed to "Leon" with its icon. */
const APPLET_SCRIPT = `on run
  set msgFile to (POSIX path of (path to home folder)) & ".leon/notify.txt"
  set msg to "Leon"
  try
    set msg to read POSIX file msgFile as «class utf8»
  end try
  display notification msg with title "Leon"
end run`;

/** A transition worth telling the user about. */
export interface AttentionEvent {
  session: Session;
  from: SessionStatus;
  to: SessionStatus;
  headline: string; // "e2e-playground needs permission"
}

const REPEAT_SUPPRESS_MS = 2 * 60_000;
const BATCH_MS = 5_000;

function headline(session: Session, to: SessionStatus): string {
  const dir = session.title ?? session.cwd.split('/').pop() ?? session.cwd;
  switch (to) {
    case 'waiting_permission':
      return `${dir} is waiting on a permission prompt`;
    case 'waiting_input':
      return `${dir} is waiting for your input`;
    case 'idle_done':
      return `${dir} finished its turn`;
    case 'dead':
      return `${dir} died mid-work`;
    default:
      return `${dir} → ${to}`;
  }
}

/**
 * Watches session status transitions and surfaces the ones that need the
 * user: finished turns, waiting-for-permission/input, deaths mid-work.
 * Delivers via macOS notifications and/or a batched digest handed to the
 * Leon agent (which decides whether it's worth a chat message).
 *
 * First-seen statuses are baseline (daemon boot floods are silent), and
 * identical notifications per session are suppressed for 2 minutes.
 */
export class NotificationService {
  private prev = new Map<string, SessionStatus>();
  private lastSent = new Map<string, number>(); // "sessionId:status" -> ts
  private batchTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private config: LeonConfig,
    private bus: EventBus,
    private notifyAgent: (digest: string) => void,
  ) {}

  start(): void {
    this.unsubscribe = this.bus.on((event) => this.onEvent(event));
    void this.ensureNotifierApp();
  }

  /* ------------- branded notifier: ~/.leon/Leon.app with the avatar ------ */

  private notifierReady = false;

  private get notifierApp(): string {
    return join(this.config.dataDir, 'Leon.app');
  }

  /** Builds the applet once per machine (osacompile + icns from leon.png).
   * Failure is fine — toasts fall back to plain osascript. */
  private async ensureNotifierApp(): Promise<void> {
    try {
      if (existsSync(this.notifierApp)) {
        this.notifierReady = true;
        return;
      }
      let icon = join(this.config.dataDir, 'leon.png');
      if (!existsSync(icon)) {
        // repo fallback: packages/core/src/services → repo root
        const repoIcon = join(
          dirname(fileURLToPath(import.meta.url)),
          '..', '..', '..', '..',
          'packages', 'web', 'public', 'leon.png',
        );
        if (!existsSync(repoIcon)) return; // no avatar — keep osascript path
        copyFileSync(repoIcon, icon);
      }
      const iconset = join(this.config.dataDir, 'leon.iconset');
      rmSync(iconset, { recursive: true, force: true });
      mkdirSync(iconset, { recursive: true });
      for (const size of [16, 32, 128, 256, 512]) {
        await execFileP('sips', ['-z', String(size), String(size), icon, '--out', join(iconset, `icon_${size}x${size}.png`)]);
        const dbl = size * 2;
        await execFileP('sips', ['-z', String(dbl), String(dbl), icon, '--out', join(iconset, `icon_${size}x${size}@2x.png`)]);
      }
      const icns = join(this.config.dataDir, 'applet.icns');
      await execFileP('iconutil', ['-c', 'icns', iconset, '-o', icns]);
      await execFileP('osacompile', ['-o', this.notifierApp, '-e', APPLET_SCRIPT]);
      copyFileSync(icns, join(this.notifierApp, 'Contents', 'Resources', 'applet.icns'));
      await execFileP('touch', [this.notifierApp]);
      rmSync(iconset, { recursive: true, force: true });
      this.notifierReady = true;
    } catch {
      // sips/osacompile unavailable or sandboxed — plain osascript still works
    }
  }

  /** One door for all toasts: branded applet when available, osascript else. */
  private deliverToast(body: string): void {
    if (this.notifierReady) {
      try {
        writeFileSync(join(this.config.dataDir, 'notify.txt'), body);
        execFile('open', ['-g', this.notifierApp], () => {});
        return;
      } catch {
        /* fall through */
      }
    }
    execFile(
      'osascript',
      ['-e', `display notification "${body.replace(/["\\]/g, '')}" with title "Leon"`],
      () => {},
    );
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.batchTimer) clearTimeout(this.batchTimer);
  }

  private onEvent(event: WsEvent): void {
    if (event.type === 'pr.upserted') {
      this.onPrEvent(event.pullRequest);
      return;
    }
    if (event.type !== 'session.status') return;
    const session = event.session;
    const prev = this.prev.get(session.id);
    this.prev.set(session.id, session.status);
    if (session.archivedAt) return;
    if (prev === undefined || prev === session.status) return; // baseline / no-op

    if (!this.isNotable(prev, session.status)) return;

    const key = `${session.id}:${session.status}`;
    const last = this.lastSent.get(key) ?? 0;
    if (Date.now() - last < REPEAT_SUPPRESS_MS) return;
    this.lastSent.set(key, Date.now());

    const attention: AttentionEvent = {
      session,
      from: prev,
      to: session.status,
      headline: headline(session, session.status),
    };
    if (this.config.notifications.desktop) this.toast(attention);
    if (this.config.notifications.chat) this.enqueueForAgent(attention);
  }

  /* ---------------- PR activity (comments, checks, reviews, merges) ----- */

  private prPrev = new Map<
    string,
    { commentAt: string | null; checks: string; review: string | null; state: string }
  >();

  private onPrEvent(pr: PullRequest): void {
    const prev = this.prPrev.get(pr.id);
    this.prPrev.set(pr.id, {
      commentAt: pr.lastCommentAt ?? null,
      checks: pr.checks,
      review: pr.reviewDecision ?? null,
      state: pr.state,
    });
    if (!prev) return; // baseline — daemon boot floods stay silent

    const lines: string[] = [];
    if (pr.lastCommentAt && pr.lastCommentAt !== prev.commentAt) {
      lines.push(`PR #${pr.number} got a new comment from ${pr.lastCommentAuthor ?? 'someone'}`);
    }
    if (pr.checks === 'failing' && prev.checks !== 'failing') {
      lines.push(`PR #${pr.number}: checks are failing`);
    }
    if (pr.reviewDecision === 'approved' && prev.review !== 'approved') {
      lines.push(`PR #${pr.number} was approved`);
    }
    if (pr.reviewDecision === 'changes_requested' && prev.review !== 'changes_requested') {
      lines.push(`PR #${pr.number}: changes requested`);
    }
    if (pr.state === 'merged' && prev.state !== 'merged') {
      lines.push(`PR #${pr.number} was merged`);
    }
    for (const line of lines) {
      const key = `pr:${pr.id}:${line}`;
      const last = this.lastSent.get(key) ?? 0;
      if (Date.now() - last < REPEAT_SUPPRESS_MS) continue;
      this.lastSent.set(key, Date.now());
      const headline = `${line} — "${pr.title.slice(0, 60)}"`;
      if (this.config.notifications.desktop) this.toastText(headline);
      if (this.config.notifications.chat) {
        this.enqueueLine(`- ${headline} (${pr.url})`);
      }
    }
  }

  private toastText(body: string): void {
    this.deliverToast(body);
  }

  private isNotable(from: SessionStatus, to: SessionStatus): boolean {
    if (to === 'waiting_permission') return true; // always worth knowing
    if (to === 'waiting_input') return from === 'working';
    if (to === 'idle_done') return from === 'working';
    if (to === 'dead') return from === 'working';
    return false;
  }

  private toast(event: AttentionEvent): void {
    this.deliverToast(event.headline);
  }

  private enqueueForAgent(event: AttentionEvent): void {
    this.enqueueLine(
      `- ${event.headline} (session ${event.session.id.slice(-8).toLowerCase()}, dir ${event.session.cwd}, ${event.from} → ${event.to}, source ${event.session.statusSource})`,
    );
  }

  /** Batches digest lines (sessions AND PRs) into one agent note. */
  private enqueueLine(line: string): void {
    this.lineBatch.push(line);
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      const lines = this.lineBatch.splice(0);
      this.batchTimer = null;
      if (lines.length === 0) return;
      this.notifyAgent(lines.join('\n'));
    }, BATCH_MS);
    this.batchTimer.unref?.();
  }

  private lineBatch: string[] = [];
}
