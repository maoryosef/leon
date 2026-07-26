import type { PrChecks, PullRequest } from '@leon/shared';

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

/**
 * All pull requests Leon is monitoring (every open PR you authored, plus
 * PRs of live session branches) — including ones not linked to any task.
 * Merged/closed PRs linger dimmed until the next daemon restart prunes them.
 */
export function PrRail({ pullRequests }: { pullRequests: PullRequest[] }) {
  const prs = [...pullRequests].sort((a, b) => {
    const doneA = a.state === 'merged' || a.state === 'closed' ? 1 : 0;
    const doneB = b.state === 'merged' || b.state === 'closed' ? 1 : 0;
    return doneA - doneB || (a.url < b.url ? -1 : 1);
  });
  if (prs.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-panel px-3 py-1.5">
      <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-faint select-none">
        pull requests
      </span>
      {prs.map((pr) => {
        const done = pr.state === 'merged' || pr.state === 'closed';
        const repoShort = repoFromUrl(pr.url);
        return (
          <a
            key={pr.id}
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            title={`${pr.title}\n${pr.state} · checks ${pr.checks}${pr.reviewDecision ? ` · ${REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision}` : ''}`}
            className={`flex shrink-0 items-center gap-1.5 border border-line-strong px-2 py-0.5 font-mono text-[10.5px] hover:bg-raise ${
              done ? 'opacity-40' : ''
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${CHECK_DOT[pr.checks]} ${
                pr.checks === 'pending' && !done ? 'throb' : ''
              }`}
            />
            <span className="text-dim">{repoShort}</span>
            <span className="text-txt">#{pr.number}</span>
            <span className="max-w-52 truncate text-dim">{pr.title}</span>
            {pr.state === 'merged' && <span className="text-faint">merged</span>}
            {pr.state === 'closed' && <span className="text-faint">closed</span>}
            {pr.state === 'draft' && <span className="text-faint">draft</span>}
            {!done && pr.reviewDecision === 'approved' && <span className="text-ok">✓ approved</span>}
            {!done && pr.reviewDecision === 'changes_requested' && (
              <span className="text-danger">✗ changes</span>
            )}
          </a>
        );
      })}
    </div>
  );
}

function repoFromUrl(url: string): string {
  // https://github.com/owner/repo/pull/N → repo
  const parts = url.split('/');
  return parts.length >= 5 ? (parts[4] ?? '') : '';
}
