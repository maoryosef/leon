import type { PrChecks, PullRequest, Session } from '@leon/shared';
import { sessionTitle, truncateMiddle } from '../lib/format';
import { relativeTime, useNow } from '../lib/time';
import { setChatDraft, setOpenSession } from '../lib/ws-store';

const CHECK_DOT: Record<PrChecks, string> = {
  passing: 'bg-ok',
  failing: 'bg-danger',
  pending: 'bg-accent',
  none: 'bg-faint',
};

const REVIEW_LABEL: Record<string, string> = {
  approved: 'approved',
  changes_requested: 'changes requested',
  review_required: 'review required',
};

function repoFromUrl(url: string): string {
  // https://github.com/owner/repo/pull/N → repo
  const parts = url.split('/');
  return parts.length >= 5 ? (parts[4] ?? '') : '';
}

/** idle_done sessions younger than this show up as "✓ FINISHED". */
const FRESH_DONE_MS = 30 * 60 * 1000;

type AttentionKind = 'permission' | 'input' | 'finished';

const CARD_BORDER: Record<AttentionKind, string> = {
  permission: 'border-accent/50',
  input: 'border-accent/25',
  finished: 'border-line',
};

const BADGE_CLASS: Record<AttentionKind, string> = {
  permission: 'text-accent',
  input: 'text-accent/80',
  finished: 'text-ok',
};

function badgeLabel(kind: AttentionKind): string {
  switch (kind) {
    case 'permission':
      return 'PERMISSION';
    case 'input':
      return 'INPUT';
    case 'finished':
      return '✓ FINISHED';
  }
}

function AttentionCard({
  session,
  kind,
  now,
}: {
  session: Session;
  kind: AttentionKind;
  now: number;
}) {
  const name = sessionTitle(session);
  return (
    <div className={`flex flex-col gap-1 border bg-bg px-2 py-1.5 ${CARD_BORDER[kind]}`}>
      <span
        className={`font-mono text-[9.5px] uppercase tracking-[0.1em] ${BADGE_CLASS[kind]}`}
        title={`since ${session.statusSince}`}
      >
        {badgeLabel(kind)} · {relativeTime(session.statusSince, now)}
      </span>
      <span className="truncate text-[12px] font-medium text-txt" title={session.cwd}>
        {name}
      </span>
      <span className="truncate font-mono text-[10.5px] text-dim">
        {session.currentActivity ?? truncateMiddle(session.cwd, 36)}
      </span>
      <div className="flex items-center gap-1.5 pt-0.5">
        <button
          type="button"
          onClick={() => setOpenSession(session.id)}
          className="border border-line-strong bg-raise px-1.5 py-0.5 font-mono text-[10px] text-dim hover:border-dim hover:text-txt"
        >
          open ›
        </button>
        <button
          type="button"
          onClick={() => setChatDraft(`what's going on in ${name}?`)}
          className="border border-line px-1.5 py-0.5 font-mono text-[10px] text-dim hover:border-accent hover:text-accent"
        >
          ask Leon
        </button>
      </div>
    </div>
  );
}

function PrRow({ pr }: { pr: PullRequest }) {
  const done = pr.state === 'merged' || pr.state === 'closed';
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={`${pr.title}\n${pr.state} · checks ${pr.checks}${
        pr.reviewDecision ? ` · ${REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision}` : ''
      }`}
      className={`flex flex-col gap-0.5 border border-line px-1.5 py-1 hover:bg-raise ${
        done ? 'opacity-40' : ''
      }`}
    >
      <span className="flex items-center gap-1.5 font-mono text-[10.5px]">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${CHECK_DOT[pr.checks]} ${
            pr.checks === 'pending' && !done ? 'throb' : ''
          }`}
        />
        <span className="truncate text-dim">{repoFromUrl(pr.url)}</span>
        <span className="text-txt">#{pr.number}</span>
        <span className="ml-auto shrink-0 text-[10px]">
          {pr.state === 'merged' && <span className="text-faint">merged</span>}
          {pr.state === 'closed' && <span className="text-faint">closed</span>}
          {pr.state === 'draft' && <span className="text-faint">draft</span>}
          {!done && pr.reviewDecision === 'approved' && <span className="text-ok">✓ approved</span>}
          {!done && pr.reviewDecision === 'changes_requested' && (
            <span className="text-danger">✗ changes</span>
          )}
        </span>
      </span>
      <span className="truncate font-mono text-[10.5px] text-dim">{pr.title}</span>
    </a>
  );
}

export function AttentionDock({
  sessions,
  pullRequests,
  mobileOpen,
}: {
  sessions: Session[];
  pullRequests: PullRequest[];
  /** below 1100px the dock is an overlay drawer; this is its open state */
  mobileOpen: boolean;
}) {
  const now = useNow();

  const live = sessions.filter((session) => !session.archivedAt);
  const bySinceAsc = (a: Session, b: Session) =>
    Date.parse(a.statusSince) - Date.parse(b.statusSince);

  const waitingPermission = live
    .filter((session) => session.status === 'waiting_permission')
    .sort(bySinceAsc);
  const waitingInput = live
    .filter((session) => session.status === 'waiting_input')
    .sort(bySinceAsc);
  const finished = live
    .filter(
      (session) =>
        session.status === 'idle_done' && now - Date.parse(session.statusSince) < FRESH_DONE_MS,
    )
    .sort((a, b) => Date.parse(b.statusSince) - Date.parse(a.statusSince));

  const needsYou = waitingPermission.length + waitingInput.length;

  // merged/closed PRs are finished business — no point showing them
  const prs = pullRequests
    .filter((pr) => pr.state === 'open' || pr.state === 'draft')
    .sort((a, b) => (a.url < b.url ? -1 : 1));

  return (
    <aside
      className={`flex w-[280px] shrink-0 flex-col gap-2 overflow-y-auto border-l border-line bg-panel p-2.5 ${
        mobileOpen
          ? 'max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-7 max-[1100px]:z-20 max-[1100px]:shadow-[-12px_0_40px_rgba(0,0,0,0.7)]'
          : 'max-[1100px]:hidden'
      }`}
    >
      {needsYou > 0 ? (
        <div className="flex shrink-0 items-center gap-2 border border-accent/60 bg-accent/10 px-2.5 py-1.5">
          <span className="attn-pulse size-2 shrink-0 rounded-full bg-accent" />
          <span className="font-mono text-[10.5px] font-bold tracking-[0.12em] text-accent select-none">
            NEEDS YOU · {needsYou}
          </span>
        </div>
      ) : (
        <p className="shrink-0 px-0.5 py-1 font-mono text-[10.5px] text-faint">
          all clear — nothing needs you
        </p>
      )}

      {waitingPermission.map((session) => (
        <AttentionCard key={session.id} session={session} kind="permission" now={now} />
      ))}
      {waitingInput.map((session) => (
        <AttentionCard key={session.id} session={session} kind="input" now={now} />
      ))}
      {finished.map((session) => (
        <AttentionCard key={session.id} session={session} kind="finished" now={now} />
      ))}

      <div className="mt-2 flex shrink-0 flex-col gap-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-faint select-none">
          pull requests
        </span>
        {prs.length === 0 ? (
          <p className="font-mono text-[10.5px] text-faint">none tracked</p>
        ) : (
          prs.map((pr) => <PrRow key={pr.id} pr={pr} />)
        )}
      </div>
    </aside>
  );
}
