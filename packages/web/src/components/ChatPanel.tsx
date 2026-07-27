import type { ChatMessage } from '@leon/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fetchChatHistory, sendChat } from '../lib/api';
import { clockTime, dayLabel, differentDay, relativeTime, useNow } from '../lib/time';
import { markChatSeen, seedChatHistory, setChatDraft, useBoardState } from '../lib/ws-store';
import { ApprovalCard } from './ApprovalCard';
import { Markdown } from './Markdown';

function toolTooltip(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return '';
  }
}

function Message({
  message,
  now,
  fresh,
}: {
  message: ChatMessage;
  now: number;
  fresh?: boolean;
}) {
  // one-shot arrival highlight for messages that land while the tab is visible
  const arrive = fresh ? ' msg-arrive' : '';
  // always-visible clock time; the tooltip carries the relative + full form
  const stamp = (
    <span
      title={`${relativeTime(message.createdAt, now)} — ${new Date(message.createdAt).toLocaleString()}`}
      className="mt-0.5 font-mono text-[9px] text-faint/80"
    >
      {clockTime(message.createdAt)}
    </span>
  );

  if (message.content.kind === 'tool') {
    return (
      <div className={`group flex flex-col items-start${arrive}`}>
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
      <div className={`group flex flex-col items-end${arrive}`}>
        <div className="max-w-[85%] whitespace-pre-wrap border border-line bg-raise px-2.5 py-1.5 text-[13px] text-txt">
          {message.content.text}
        </div>
        {stamp}
      </div>
    );
  }

  // assistant — and 'system', which the daemon shouldn't send but the schema allows.
  if (message.role === 'system') {
    return (
      <div className={`group flex flex-col items-start${arrive}`}>
        <div className="whitespace-pre-wrap font-mono text-[11px] text-faint">
          {message.content.text}
        </div>
        {stamp}
      </div>
    );
  }
  return (
    <div className={`group flex flex-col items-start${arrive}`}>
      <div className="max-w-[85%] text-[13px] leading-relaxed text-txt">
        <Markdown text={message.content.text} />
      </div>
      {stamp}
    </div>
  );
}

const MAX_INPUT_HEIGHT = 110; // ≈ 5 lines

/** Leon's chat — the literal center column of the command center. Always visible. */
export function ChatPanel() {
  const {
    chatMessages,
    chatLoaded,
    chatStatus,
    approvals,
    lastApprovalFailure,
    unreadCount,
    chatDraft,
  } = useBoardState();
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

  /* -------------------------------------------------------------- */
  /* Unread: seen-marking, arrival highlight, tab-title badge.        */
  /* -------------------------------------------------------------- */

  // Messages count as seen only after the user could plausibly have read
  // them: document visible + scrolled near the bottom, held for ~1s (so a
  // message that flashes by while hidden doesn't get eaten).
  const seenTimerRef = useRef<number | null>(null);

  const scheduleMarkSeen = () => {
    const canSee = () => pinnedRef.current && document.visibilityState === 'visible';
    if (!canSee() || seenTimerRef.current !== null) return;
    seenTimerRef.current = window.setTimeout(() => {
      seenTimerRef.current = null;
      if (canSee()) markChatSeen();
    }, 1000);
  };

  useEffect(() => {
    const onVisibility = () => scheduleMarkSeen();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (seenTimerRef.current !== null) window.clearTimeout(seenTimerRef.current);
    };
    // scheduleMarkSeen reads only refs + document state, so the first
    // render's closure stays correct.
  }, []);

  // Tab-title badge: surfaces arrivals while the tab is hidden.
  useEffect(() => {
    const update = () => {
      document.title =
        unreadCount > 0 && document.visibilityState === 'hidden'
          ? `(${unreadCount}) Leon`
          : 'Leon';
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      document.title = 'Leon';
    };
  }, [unreadCount]);

  // Arrival highlight: remember which ids landed after the history seed so
  // their rows can play the one-shot msg-arrive animation.
  const knownIdsRef = useRef<Set<string> | null>(null);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(() => new Set());
  const freshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // Absorb everything up to (and including) the history seed silently.
    if (!chatLoaded || knownIdsRef.current === null) {
      knownIdsRef.current = new Set(chatMessages.map((message) => message.id));
      return;
    }
    const known = knownIdsRef.current;
    const fresh: string[] = [];
    for (const message of chatMessages) {
      if (known.has(message.id)) continue;
      known.add(message.id);
      if (message.role !== 'user') fresh.push(message.id);
    }
    if (fresh.length === 0) return;
    setFreshIds((prev) => new Set([...prev, ...fresh]));
    // Forget once the animation is over so a later re-render doesn't replay it.
    if (freshTimerRef.current !== null) window.clearTimeout(freshTimerRef.current);
    freshTimerRef.current = window.setTimeout(() => setFreshIds(new Set()), 2000);
  }, [chatMessages, chatLoaded]);

  useEffect(
    () => () => {
      if (freshTimerRef.current !== null) window.clearTimeout(freshTimerRef.current);
    },
    [],
  );

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinnedRef.current = atBottom;
    if (atBottom) {
      setHasNew(false);
      scheduleMarkSeen();
    }
  };

  const jumpToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setHasNew(false);
    scheduleMarkSeen();
  };

  useLayoutEffect(() => {
    const el = listRef.current;
    const grew = chatMessages.length > prevCountRef.current;
    prevCountRef.current = chatMessages.length;
    if (!el) return;
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    else if (grew) setHasNew(true);
    scheduleMarkSeen();
  }, [chatMessages]);

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

  // Other panels ("ask Leon" in the dock) pre-fill the input via the store.
  useEffect(() => {
    if (chatDraft == null) return;
    setText(chatDraft);
    setChatDraft(null);
    const el = inputRef.current;
    if (el) el.focus();
    requestAnimationFrame(resizeInput);
  }, [chatDraft]);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || sendMutation.isPending) return;
    sendMutation.mutate({ text: trimmed });
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-6 py-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint select-none">
          Leon
        </span>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={jumpToBottom}
            title="Jump to unread messages"
            className="border border-accent/50 bg-accent/10 px-1.5 font-mono text-[10px] font-bold leading-4 text-accent hover:border-accent"
          >
            {unreadCount} new
          </button>
        )}
        {chatStatus.state === 'thinking' && (
          <span className="throb h-1.5 w-1.5 rounded-full bg-accent" />
        )}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={listRef}
          onScroll={handleScroll}
          className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-6 py-4"
        >
          {chatMessages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <p className="px-4 text-center font-mono text-[11px] text-faint">
                {chatLoaded ? 'Talk to Leon — he’s watching your sessions.' : 'loading chat…'}
              </p>
            </div>
          ) : (
            chatMessages.map((message, index) => {
              const prev = chatMessages[index - 1];
              const newDay = !prev || differentDay(prev.createdAt, message.createdAt);
              return (
                <div key={message.id} className="contents">
                  {newDay && (
                    <div className="my-1.5 flex justify-center">
                      <span className="border border-line bg-raise px-2.5 py-0.5 font-mono text-[10.5px] tracking-wide text-dim">
                        {dayLabel(message.createdAt)}
                      </span>
                    </div>
                  )}
                  <Message message={message} now={now} fresh={freshIds.has(message.id)} />
                </div>
              );
            })
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
            ↓ {unreadCount > 0 ? `${unreadCount} new` : 'new'}
          </button>
        )}
      </div>

      {pendingApprovals.length > 0 && (
        <div className="flex shrink-0 flex-col gap-2 border-t border-line px-6 py-2.5">
          {pendingApprovals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} />
          ))}
        </div>
      )}

      <div className="shrink-0 border-t border-line px-6 py-2.5">
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
            className="min-w-0 flex-1 resize-none border border-line bg-bg px-2 py-1.5 text-[13px] text-txt placeholder:text-faint outline-none focus:border-line-strong"
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
    </section>
  );
}
