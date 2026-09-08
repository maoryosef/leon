import type { AgentStats, UsageLimit } from '@leon/shared';
import { timeUntil, useNow } from '../lib/time';
import { useBoardState } from '../lib/ws-store';

/** 84_213 → "84K"; the bar has no room for exact token counts. */
function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 || Number.isInteger(millions) ? Math.round(millions) : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** Sub-cent spend is noise; past that, cents matter. */
function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(usd < 1000 ? 1 : 0)}`;
}

/** "claude-haiku-4-5-20251001" → "haiku-4-5": the part that identifies it. */
function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/** Leon's own conversation: which model, how full its context, what it cost. */
function LeonStats({ stats }: { stats: AgentStats }) {
  const { contextTokens, contextWindow, costUsd } = stats;
  const percent =
    contextTokens != null && contextWindow
      ? Math.min(100, Math.round((contextTokens / contextWindow) * 100))
      : null;
  // context pressure is the thing worth flagging: a full window means a compact
  const tone = percent == null || percent < 70 ? 'text-dim' : percent < 90 ? 'text-accent' : 'text-danger';

  return (
    <>
      <span
        className="flex items-center gap-1.5"
        title={stats.model ? `Leon is running on ${stats.model}` : 'Leon has not answered yet'}
      >
        <span className="text-faint uppercase tracking-[0.1em]">leon</span>
        <span className="text-info">{stats.model ? shortModel(stats.model) : '—'}</span>
      </span>

      {percent != null && (
        <span
          className="flex items-center gap-1.5"
          title={`Leon's context: ${contextTokens?.toLocaleString()} of ${contextWindow?.toLocaleString()} tokens`}
        >
          <span className="text-faint uppercase tracking-[0.1em]">ctx</span>
          <span aria-hidden className="relative h-1.5 w-14 overflow-hidden border border-line bg-bg">
            <span
              className={`absolute inset-y-0 left-0 ${
                percent < 70 ? 'bg-info' : percent < 90 ? 'bg-accent' : 'bg-danger'
              }`}
              style={{ width: `${percent}%` }}
            />
          </span>
          <span className={`tabular-nums ${tone}`}>
            {percent}%
            {contextTokens != null && contextWindow ? (
              <span className="text-faint">
                {' '}
                ({compactTokens(contextTokens)}/{compactTokens(contextWindow)})
              </span>
            ) : null}
          </span>
        </span>
      )}

      {costUsd > 0 && (
        <span className="flex items-center gap-1.5" title="Spent on Leon's own conversation">
          <span className="text-faint uppercase tracking-[0.1em]">spent</span>
          <span className="tabular-nums text-dim">{money(costUsd)}</span>
        </span>
      )}
    </>
  );
}

/** Weekly pools first — they're the ones that decide whether the week ends early. */
const ORDER: Record<string, number> = { weekly_all: 0, weekly_scoped: 1, session: 2 };

function sortForBar(limits: UsageLimit[]): UsageLimit[] {
  return limits
    .slice()
    .sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9) || a.label.localeCompare(b.label));
}

const TONE: Record<UsageLimit['severity'], { text: string; fill: string }> = {
  normal: { text: 'text-dim', fill: 'bg-ok' },
  warning: { text: 'text-accent', fill: 'bg-accent' },
  critical: { text: 'text-danger', fill: 'bg-danger' },
};

function Gauge({ limit }: { limit: UsageLimit }) {
  const tone = TONE[limit.severity] ?? TONE.normal;
  return (
    <span className="flex items-center gap-1.5" title={`${limit.percent}% of the ${limit.label} limit used`}>
      <span className="text-faint uppercase tracking-[0.1em]">{limit.label}</span>
      <span
        aria-hidden
        className="relative h-1.5 w-14 overflow-hidden border border-line bg-bg"
      >
        <span
          className={`absolute inset-y-0 left-0 ${tone.fill}`}
          style={{ width: `${limit.percent}%` }}
        />
      </span>
      <span className={`tabular-nums ${tone.text}`}>{limit.percent}%</span>
    </span>
  );
}

/**
 * The window's bottom rail: how much of the plan's pools this week has eaten.
 * Fed by the daemon polling the same usage endpoint Claude Code's own status
 * line reads, so it stays live whether or not a session is running.
 */
export function StatusBar() {
  const { usage, agentStats } = useBoardState();
  const now = useNow(60_000);
  const limits = usage ? sortForBar(usage.limits) : [];
  const hasLeonStats =
    agentStats != null &&
    (agentStats.model != null || agentStats.contextTokens != null || agentStats.costUsd > 0);
  if (limits.length === 0 && !hasLeonStats) return null;
  // both weekly pools reset together; the first one carries the countdown
  const resetsAt = limits.find((limit) => limit.group === 'weekly')?.resetsAt ?? null;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 font-mono text-[10.5px] select-none">
      {limits.map((limit) => (
        <Gauge key={limit.kind + limit.label} limit={limit} />
      ))}

      {resetsAt && (
        <span className="text-faint" title={new Date(resetsAt).toLocaleString()}>
          resets in {timeUntil(resetsAt, now)}
        </span>
      )}

      {hasLeonStats && (
        <>
          <span aria-hidden className="h-3 w-px bg-line" />
          <LeonStats stats={agentStats} />
        </>
      )}

      {usage?.error && (
        <span
          className="ml-auto text-faint"
          title={`${usage.error} — showing the last figures Leon got`}
        >
          stale
        </span>
      )}
    </footer>
  );
}
