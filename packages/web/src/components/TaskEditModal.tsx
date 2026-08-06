import type { JiraIssue, Session, Task } from '@leon/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { linkSession, updateTask } from '../lib/api';
import { basename, sessionTitle } from '../lib/format';
import { applySession, applyTask, useBoardState } from '../lib/ws-store';
import { StatusBadge } from './StatusBadge';

/** A Jira key typed by hand — accepted even when it isn't in the synced list. */
const JIRA_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;

/**
 * Everything about one task in one place: its title, the Jira issue it tracks,
 * and which sessions belong to it. Nothing is written until Save — sessions
 * moved in or out are applied as link calls alongside the task patch.
 */
export function TaskEditModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const board = useBoardState();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState(task.title);
  const [jiraKey, setJiraKey] = useState<string | null>(task.jiraKey ?? null);
  const [jiraFilter, setJiraFilter] = useState('');
  const [assigned, setAssigned] = useState<Set<string>>(
    () =>
      new Set(
        board.sessions
          .filter((session) => !session.archivedAt && session.taskId === task.id)
          .map((session) => session.id),
      ),
  );

  const liveSessions = useMemo(
    () =>
      board.sessions
        .filter((session) => !session.archivedAt && session.status !== 'dead')
        .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)),
    [board.sessions],
  );

  const taskById = useMemo(
    () => new Map(board.tasks.map((entry) => [entry.id, entry])),
    [board.tasks],
  );

  const jiraMatches = useMemo(() => {
    const needle = jiraFilter.trim().toLowerCase();
    const pool = board.jiraIssues;
    if (!needle) return pool.slice(0, 8);
    return pool
      .filter(
        (issue) =>
          issue.key.toLowerCase().includes(needle) ||
          issue.summary.toLowerCase().includes(needle),
      )
      .slice(0, 8);
  }, [board.jiraIssues, jiraFilter]);

  const typedKey = jiraFilter.trim().toUpperCase();
  const offerTyped =
    JIRA_KEY.test(typedKey) && !jiraMatches.some((issue) => issue.key === typedKey);

  const selectedIssue: JiraIssue | undefined = board.jiraIssues.find(
    (issue) => issue.key === jiraKey,
  );

  const save = useMutation({
    mutationFn: async () => {
      const trimmed = title.trim();
      const patch = {
        ...(trimmed !== task.title ? { title: trimmed } : {}),
        ...((jiraKey ?? null) !== (task.jiraKey ?? null) ? { jiraKey } : {}),
      };
      if (Object.keys(patch).length > 0) {
        applyTask(await updateTask(task.id, patch));
      }
      // sessions that changed side, in both directions
      for (const session of board.sessions) {
        if (session.archivedAt) continue;
        const wasMine = session.taskId === task.id;
        const isMine = assigned.has(session.id);
        if (wasMine === isMine) continue;
        applySession(await linkSession(session.id, isMine ? task.id : null));
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['state'] });
      onClose();
    },
  });

  const toggle = (sessionId: string) =>
    setAssigned((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });

  const field =
    'w-full border border-line bg-bg px-2 py-1.5 text-[12px] text-txt placeholder:text-faint outline-none focus:border-line-strong';
  const label = 'text-[10px] font-medium uppercase tracking-[0.14em] text-faint select-none';

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 pt-[10vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <form
        className="flex max-h-[80vh] w-[520px] flex-col border border-line-strong bg-panel shadow-[0_8px_40px_rgba(0,0,0,0.8)]"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim() && !save.isPending) save.mutate();
        }}
      >
        <div className={`border-b border-line px-3 py-2 ${label}`}>Edit task</div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          <div className="flex flex-col gap-1.5">
            <span className={label}>Title</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Task title"
              className={`${field} text-[14px] font-semibold`}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className={label}>Jira ticket</span>
            {jiraKey ? (
              <div className="flex items-center gap-2 border border-line bg-bg px-2 py-1.5">
                <span className="shrink-0 border border-line-strong px-1 py-px font-mono text-[10px] text-dim">
                  {jiraKey}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-dim">
                  {selectedIssue?.summary ?? 'not in the synced list'}
                </span>
                <button
                  type="button"
                  onClick={() => setJiraKey(null)}
                  className="shrink-0 font-mono text-[11px] text-faint hover:text-danger"
                >
                  unlink
                </button>
              </div>
            ) : (
              <>
                <input
                  value={jiraFilter}
                  onChange={(event) => setJiraFilter(event.target.value)}
                  placeholder="Search your issues, or type a key (ENG-1234)"
                  className={`${field} font-mono text-[11.5px]`}
                />
                <div className="flex max-h-40 flex-col overflow-y-auto border border-line">
                  {offerTyped && (
                    <button
                      type="button"
                      onClick={() => setJiraKey(typedKey)}
                      className="flex items-center gap-2 border-b border-line px-2 py-1.5 text-left hover:bg-raise"
                    >
                      <span className="font-mono text-[10.5px] text-accent">{typedKey}</span>
                      <span className="text-[11px] text-faint">use this key</span>
                    </button>
                  )}
                  {jiraMatches.map((issue) => (
                    <button
                      key={issue.key}
                      type="button"
                      onClick={() => setJiraKey(issue.key)}
                      className="flex items-center gap-2 border-b border-line px-2 py-1.5 text-left last:border-b-0 hover:bg-raise"
                    >
                      <span className="shrink-0 font-mono text-[10.5px] text-dim">
                        {issue.key}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11.5px] text-txt">
                        {issue.summary}
                      </span>
                      <span className="shrink-0 font-mono text-[9.5px] text-faint">
                        {issue.status}
                      </span>
                    </button>
                  ))}
                  {jiraMatches.length === 0 && !offerTyped && (
                    <p className="px-2 py-2 text-center font-mono text-[10.5px] text-faint">
                      {board.jiraIssues.length === 0
                        ? 'no synced issues — ask Leon to sync Jira'
                        : 'no match'}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="flex min-h-0 flex-col gap-1.5">
            <span className={label}>Sessions · {assigned.size} assigned</span>
            <div className="flex max-h-56 flex-col overflow-y-auto border border-line">
              {liveSessions.length === 0 ? (
                <p className="px-2 py-2 text-center font-mono text-[10.5px] text-faint">
                  no live sessions
                </p>
              ) : (
                liveSessions.map((session) => (
                  <SessionPick
                    key={session.id}
                    session={session}
                    checked={assigned.has(session.id)}
                    ownerTitle={
                      session.taskId && session.taskId !== task.id
                        ? (taskById.get(session.taskId)?.title ?? null)
                        : null
                    }
                    onToggle={() => toggle(session.id)}
                  />
                ))
              )}
            </div>
          </div>

          {save.isError && (
            <div className="font-mono text-[11px] text-danger">
              Could not save. Check the daemon and try again.
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-line px-3 py-2">
          <button
            type="button"
            onClick={onClose}
            className="border border-line px-2.5 py-1 text-[11px] text-dim hover:border-line-strong hover:text-txt"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim() || save.isPending}
            className="border border-line-strong bg-raise px-2.5 py-1 text-[11px] font-medium text-txt hover:border-dim disabled:cursor-default disabled:opacity-40"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** One row in the session picker: checkbox, name, where it currently lives. */
function SessionPick({
  session,
  checked,
  ownerTitle,
  onToggle,
}: {
  session: Session;
  checked: boolean;
  /** title of the task it belongs to today, when that isn't this one */
  ownerTitle: string | null;
  onToggle: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-2 border-b border-line px-2 py-1.5 last:border-b-0 hover:bg-raise ${
        checked ? 'bg-raise/60' : ''
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="size-3 shrink-0 accent-accent"
      />
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-txt" title={session.cwd}>
        {sessionTitle(session)}
      </span>
      {ownerTitle && !checked && (
        <span className="shrink-0 font-mono text-[9.5px] text-faint" title="currently assigned to">
          in {ownerTitle}
        </span>
      )}
      <span className="shrink-0 font-mono text-[9.5px] text-faint">{basename(session.cwd)}</span>
      <StatusBadge status={session.status} source={session.statusSource} />
    </label>
  );
}
