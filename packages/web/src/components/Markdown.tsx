import type { PrChecks, PullRequest, Session, SessionStatus } from '@leon/shared';
import type { ComponentProps, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { basename } from '../lib/format';
import { setOpenSession, useBoardState } from '../lib/ws-store';

type MdComponents = ComponentProps<typeof ReactMarkdown>['components'];

/* ------------------------------------------------------------------ */
/* Session / PR chips — inline code that names a live session (or a    */
/* tracked PR number) becomes a clickable deep link.                   */
/* ------------------------------------------------------------------ */

const SESSION_DOT: Record<SessionStatus, string> = {
  waiting_permission: 'bg-accent',
  waiting_input: 'bg-accent',
  working: 'bg-ok',
  idle_done: 'bg-info',
  dead: 'bg-faint',
  unknown: 'bg-faint',
};

const PR_DOT: Record<PrChecks, string> = {
  passing: 'bg-ok',
  failing: 'bg-danger',
  pending: 'bg-accent',
  none: 'bg-faint',
};

/**
 * Case-insensitive match of a code span against live (non-archived) sessions:
 * exact match on id, cwd basename, tmux session name, pane id ("%49") or
 * title; suffix match too, but only for needles ≥ 4 chars so short spans
 * like `on` don't swallow `leon`.
 */
function matchSession(sessions: Session[], raw: string): Session | undefined {
  const needle = raw.trim().toLowerCase();
  if (needle.length < 2) return undefined;
  const allowSuffix = needle.length >= 4;
  return sessions.find((session) => {
    if (session.archivedAt) return false;
    const fields = [
      session.id,
      basename(session.cwd),
      session.tmuxSessionName,
      session.tmuxPaneId,
      session.title ?? '',
    ];
    return fields.some((field) => {
      const value = field.toLowerCase();
      if (!value) return false;
      return value === needle || (allowSuffix && value.endsWith(needle));
    });
  });
}

/** `#1121` (or `1121`) → the tracked PR with that number, if any. */
function matchPullRequest(pullRequests: PullRequest[], raw: string): PullRequest | undefined {
  const match = /^#?(\d+)$/.exec(raw.trim());
  if (!match) return undefined;
  const number = Number(match[1]);
  return pullRequests.find((pr) => pr.number === number);
}

const CHIP_CLASS =
  'inline-flex max-w-full items-center gap-1 border border-line-strong bg-bg px-1 py-px ' +
  'align-baseline font-mono text-[11px] text-txt transition-colors hover:border-accent';

function InlineCode({ children }: { children?: ReactNode }) {
  const { sessions, pullRequests } = useBoardState();

  const text =
    typeof children === 'string'
      ? children
      : Array.isArray(children) && children.every((child) => typeof child === 'string')
        ? children.join('')
        : null;

  if (text !== null) {
    const session = matchSession(sessions, text);
    if (session) {
      return (
        <button
          type="button"
          onClick={() => setOpenSession(session.id)}
          title={`open session · ${session.cwd} · ${session.status}`}
          className={CHIP_CLASS}
        >
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${SESSION_DOT[session.status]}`} />
          <span className="truncate">{text}</span>
          <span className="text-faint">›</span>
        </button>
      );
    }
    const pr = matchPullRequest(pullRequests, text);
    if (pr) {
      return (
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${pr.title} · ${pr.state} · checks ${pr.checks}`}
          className={CHIP_CLASS}
        >
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${PR_DOT[pr.checks]}`} />
          <span className="truncate">{text}</span>
          <span className="text-faint">›</span>
        </a>
      );
    }
  }

  return (
    <code className="border border-line bg-bg px-1 py-px font-mono text-[11px] text-txt">
      {children}
    </code>
  );
}

/**
 * Markdown for Leon's chat messages. XSS-safe by construction:
 * react-markdown renders a React element tree (never innerHTML) and raw
 * HTML in the source is ignored by default — do NOT add rehype-raw.
 */
const components: MdComponents = {
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-txt">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-4">{children}</ol>,
  li: ({ children }) => <li className="marker:text-faint">{children}</li>,
  code: ({ children, className }) =>
    className ? (
      // block code (```lang) — className carries language-*
      <code className={`${className} block`}>{children}</code>
    ) : (
      <InlineCode>{children}</InlineCode>
    ),
  pre: ({ children }) => (
    <pre className="my-1.5 overflow-x-auto border border-line bg-bg p-2 font-mono text-[11px] leading-relaxed text-dim">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-line-strong pl-2 text-dim">{children}</blockquote>
  ),
  h1: ({ children }) => <p className="mt-2 mb-1 text-[13px] font-semibold text-txt">{children}</p>,
  h2: ({ children }) => <p className="mt-2 mb-1 text-[13px] font-semibold text-txt">{children}</p>,
  h3: ({ children }) => <p className="mt-2 mb-1 font-semibold text-txt">{children}</p>,
  hr: () => <hr className="my-2 border-line" />,
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="border-collapse font-mono text-[11px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line bg-raise px-2 py-0.5 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-line px-2 py-0.5">{children}</td>,
  input: (props) => <input {...props} disabled className="mr-1 accent-current" />, // GFM task lists
};

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}
