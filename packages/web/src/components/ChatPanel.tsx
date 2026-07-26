import type { ChatMessage } from '@leon/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fetchChatHistory, sendChat } from '../lib/api';
import { relativeTime, useNow } from '../lib/time';
import { seedChatHistory, useBoardState } from '../lib/ws-store';
import { ApprovalCard } from './ApprovalCard';
import { Markdown } from './Markdown';

const OPEN_KEY = 'leon.chat.open';

function loadOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function persistOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? 'open' : 'closed');
  } catch {
    // localStorage unavailable — the panel just won't remember.
  }
}

function toolTooltip(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return '';
  }
}

function Message({ message, now }: { message: ChatMessage; now: number }) {
  const stamp = (
    <span className="mt-0.5 font-mono text-[9.5px] text-faint opacity-0 transition-opacity group-hover:opacity-100">
      {relativeTime(message.createdAt, now)}
    </span>
  );

  if (message.content.kind === 'tool') {
    return (
      <div className="group flex flex-col items-start">
        <span
          title={toolTooltip(message.content.input)}
          className="max-w-full truncate border border-line bg-bg px-1.5 py-0.5 font-mono text-[10.5px] text-faint"
        >
          ⚙ {message.content.tool}
        </span>
        {stamp}
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="group flex flex-col items-end">
        <div className="max-w-[85%] whitespace-pre-wrap border border-line bg-raise px-2.5 py-1.5 text-[12.5px] text-txt">
          {message.content.text}
        </div>
        {stamp}
      </div>
    );
  }

  // assistant — and 'system', which the daemon shouldn't send but the schema allows.
  if (message.role === 'system') {
    return (
      <div className="group flex flex-col items-start">
        <div className="whitespace-pre-wrap font-mono text-[11px] text-faint">
          {message.content.text}
        </div>
        {stamp}
      </div>
    );
  }
  return (
    <div className="group flex flex-col items-start">
      <div className="max-w-[95%] text-[12.5px] leading-relaxed text-txt">
        <Markdown text={message.content.text} />
      </div>
      {stamp}
    </div>
  );
}

const MAX_INPUT_HEIGHT = 110; // ≈ 5 lines

export function ChatPanel() {
  const { chatMessages, chatLoaded, chatStatus, approvals, lastApprovalFailure } =
    useBoardState();
  const [open, setOpen] = useState(loadOpen);
  const [text, setText] = useState('');
  const now = useNow();

  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');

  // "✗ tool failed: …" line for the latest failed approval; dismissible, ephemeral.
  const [dismissedFailureId, setDismissedFailureId] = useState<string | null>(null);
  const approvalFailure =
    lastApprovalFailure && lastApprovalFailure.id !== dismissedFailureId
      ? lastApprovalFailure
      : null;

  // Seed history over REST; WS chat.message events keep it live afterwards.
  const { data: history } = useQuery({
    queryKey: ['chat'],
    queryFn: fetchChatHistory,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (history) seedChatHistory(history);
  }, [history]);

  const sendMutation = useMutation({
    mutationFn: sendChat,
    onSuccess: () => {
      // The backend persists + broadcasts the message; the WS echo renders it.
      setText('');
      const el = inputRef.current;
      if (el) el.style.height = 'auto';
    },
  });

  /* -------------------------------------------------------------- */
  /* Scroll pinning: stick to bottom unless the user scrolled up.    */
  /* -------------------------------------------------------------- */

  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const prevCountRef = useRef(0);
  const [hasNew, setHasNew] = useState(false);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinnedRef.current = atBottom;
    if (atBottom) setHasNew(false);
  };

  const jumpToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setHasNew(false);
  };

  // The list unmounts while collapsed, so re-pin on reopen too.
  useLayoutEffect(() => {
    if (!open) return;
    const el = listRef.current;
    const grew = chatMessages.length > prevCountRef.current;
    prevCountRef.current = chatMessages.length;
    if (!el) return;
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    else if (grew) setHasNew(true);
  }, [open, chatMessages]);

  /* -------------------------------------------------------------- */
  /* Input                                                           */
  /* -------------------------------------------------------------- */

  const inputRef = useRef<HTMLTextAreaElement>(null);

  const resizeInput = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  };

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || sendMutation.isPending) return;
    sendMutation.mutate({ text: trimmed });
  };

  const toggle = (next: boolean) => {
    setOpen(next);
    persistOpen(next);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => toggle(true)}
        title={
          pendingApprovals.length > 0
            ? `Open Leon chat — ${pendingApprovals.length} pending approval${
                pendingApprovals.length === 1 ? '' : 's'
              }`
            : 'Open Leon chat'
        }
        className="flex w-7 shrink-0 flex-col items-center justify-center gap-2.5 border-l border-line bg-panel hover:bg-raise"
      >
        {pendingApprovals.length > 0 && (
          <span className="flex flex-col items-center gap-1">
            <span className="attn-pulse size-2 rounded-full bg-accent" />
            <span className="font-mono text-[10px] font-bold text-accent select-none">
              {pendingApprovals.length}
            </span>
          </span>
        )}
        <span className="font-mono text-[10px] font-bold tracking-[0.3em] text-accent select-none [writing-mode:vertical-rl]">
          LEON
        </span>
      </button>
    );
  }

  return (
    <aside className="flex w-[400px] shrink-0 border-l border-line bg-panel max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-20 max-[1100px]:shadow-[-12px_0_40px_rgba(0,0,0,0.7)]">
      {/* slim collapse strip on the panel edge */}
      <button
        type="button"
        onClick={() => toggle(false)}
        title="Collapse chat"
        className="flex w-3.5 shrink-0 items-center justify-center border-r border-line text-faint hover:bg-raise hover:text-dim"
      >
        <span className="text-[10px] select-none">›</span>
      </button>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
            Leon
          </span>
          {chatStatus.state === 'thinking' && (
            <span className="throb h-1.5 w-1.5 rounded-full bg-accent" />
          )}
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={listRef}
            onScroll={handleScroll}
            className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-3"
          >
            {chatMessages.length === 0 ? (
              <div className="flex flex-1 items-center justify-center">
                <p className="px-4 text-center font-mono text-[11px] text-faint">
                  {chatLoaded ? 'Talk to Leon — he’s watching your sessions.' : 'loading chat…'}
                </p>
              </div>
            ) : (
              chatMessages.map((message) => (
                <Message key={message.id} message={message} now={now} />
              ))
            )}

            {chatStatus.state === 'thinking' && (
              <p className="throb font-mono text-[11px] text-dim">Leon is thinking…</p>
            )}
            {chatStatus.state === 'error' && (
              <p className="whitespace-pre-wrap font-mono text-[11px] text-danger">
                ⚠ {chatStatus.detail ?? 'agent error'}
              </p>
            )}

            {approvalFailure && (
              <div className="flex items-baseline gap-2">
                <p className="min-w-0 whitespace-pre-wrap font-mono text-[11px] text-danger">
                  ✗ {approvalFailure.toolName} failed:{' '}
                  {approvalFailure.resultSummary ?? 'no details'}
                </p>
                <button
                  type="button"
                  onClick={() => setDismissedFailureId(approvalFailure.id)}
                  className="shrink-0 font-mono text-[10px] text-faint hover:text-dim"
                >
                  dismiss
                </button>
              </div>
            )}
          </div>

          {hasNew && (
            <button
              type="button"
              onClick={jumpToBottom}
              className="absolute bottom-2 left-1/2 -translate-x-1/2 border border-line-strong bg-raise px-2.5 py-0.5 font-mono text-[10.5px] text-txt shadow-[0_4px_16px_rgba(0,0,0,0.6)] hover:border-dim"
            >
              ↓ new
            </button>
          )}
        </div>

        {pendingApprovals.length > 0 && (
          <div className="flex shrink-0 flex-col gap-2 border-t border-line p-2.5">
            {pendingApprovals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} />
            ))}
          </div>
        )}

        <div className="shrink-0 border-t border-line p-2.5">
          {sendMutation.isError && (
            <p className="mb-1.5 font-mono text-[11px] text-danger">
              Send failed — check the daemon and try again.
            </p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={text}
              rows={1}
              placeholder="Message Leon…"
              onChange={(event) => {
                setText(event.target.value);
                resizeInput();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              className="min-w-0 flex-1 resize-none border border-line bg-bg px-2 py-1.5 text-[12.5px] text-txt placeholder:text-faint outline-none focus:border-line-strong"
            />
            <button
              type="button"
              onClick={send}
              disabled={!text.trim() || sendMutation.isPending}
              className="shrink-0 border border-accent/50 bg-raise px-2.5 py-1.5 text-[11px] font-medium text-accent hover:border-accent disabled:cursor-default disabled:opacity-40"
            >
              {sendMutation.isPending ? '…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
