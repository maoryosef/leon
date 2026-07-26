import type { SessionStatus, StatusSource } from '@leon/shared';
import { STATUS_SOURCE_PRECEDENCE } from '@leon/shared';

const LABEL: Record<SessionStatus, string> = {
  working: 'working',
  waiting_permission: 'needs you',
  waiting_input: 'waiting',
  idle_done: 'idle',
  dead: 'dead',
  unknown: 'unknown',
};

/** [solid classes, hollow classes] per status. Hollow = low-confidence source. */
const STYLE: Record<SessionStatus, { solid: string; hollow: string }> = {
  working: {
    solid: 'bg-ok/15 text-ok border-ok/50',
    hollow: 'bg-transparent text-ok/80 border-ok/40 border-dashed',
  },
  waiting_permission: {
    solid: 'bg-accent text-bg border-accent font-semibold attn-pulse',
    hollow: 'bg-transparent text-accent border-accent border-dashed font-semibold attn-pulse',
  },
  waiting_input: {
    solid: 'bg-accent/10 text-accent/90 border-accent/40',
    hollow: 'bg-transparent text-accent/70 border-accent/30 border-dashed',
  },
  idle_done: {
    solid: 'bg-info/10 text-info border-info/40',
    hollow: 'bg-transparent text-info/70 border-info/30 border-dashed',
  },
  dead: {
    solid: 'bg-raise text-faint border-line line-through decoration-faint/70',
    hollow: 'bg-transparent text-faint border-line border-dashed line-through decoration-faint/70',
  },
  unknown: {
    solid: 'bg-transparent text-dim border-line-strong border-dashed',
    hollow: 'bg-transparent text-dim border-line-strong border-dashed',
  },
};

const DOT: Record<SessionStatus, string> = {
  working: 'bg-ok throb',
  waiting_permission: 'bg-current',
  waiting_input: 'bg-accent/80',
  idle_done: 'bg-info/80',
  dead: 'bg-faint',
  unknown: 'bg-faint',
};

function isLowConfidence(source: StatusSource): boolean {
  return STATUS_SOURCE_PRECEDENCE[source] <= STATUS_SOURCE_PRECEDENCE.scrape;
}

export function StatusBadge({
  status,
  source,
}: {
  status: SessionStatus;
  source: StatusSource;
}) {
  const hollow = isLowConfidence(source);
  const style = STYLE[status][hollow ? 'hollow' : 'solid'];
  return (
    <span
      title={`status: ${status} · source: ${source}${hollow ? ' (low confidence)' : ''}`}
      className={`inline-flex shrink-0 items-center gap-1.5 border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em] ${style}`}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${DOT[status]}`} />
      {LABEL[status]}
    </span>
  );
}
