import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createTask } from '../lib/api';
import { applyTask } from '../lib/ws-store';

export function NewTaskForm({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [jiraKey, setJiraKey] = useState('');
  const [description, setDescription] = useState('');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: createTask,
    onSuccess: (task) => {
      applyTask(task);
      void queryClient.invalidateQueries({ queryKey: ['state'] });
      onClose();
    },
  });

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed || mutation.isPending) return;
    mutation.mutate({
      title: trimmed,
      ...(jiraKey.trim() ? { jiraKey: jiraKey.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
    });
  };

  const field =
    'w-full border border-line bg-bg px-2 py-1.5 text-[12px] text-txt placeholder:text-faint outline-none focus:border-line-strong';

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 pt-[18vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <form
        className="w-[420px] border border-line-strong bg-panel shadow-[0_8px_40px_rgba(0,0,0,0.8)]"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="border-b border-line px-3 py-2 text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
          New task
        </div>
        <div className="flex flex-col gap-2 p-3">
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Title"
            className={field}
          />
          <input
            value={jiraKey}
            onChange={(event) => setJiraKey(event.target.value)}
            placeholder="Jira key (optional)"
            className={`${field} font-mono`}
          />
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Description (optional)"
            rows={3}
            className={`${field} resize-none`}
          />
          {mutation.isError && (
            <div className="font-mono text-[11px] text-danger">
              Could not create task. Check the daemon and try again.
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="border border-line px-2.5 py-1 text-[11px] text-dim hover:border-line-strong hover:text-txt"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || mutation.isPending}
              className="border border-line-strong bg-raise px-2.5 py-1 text-[11px] font-medium text-txt hover:border-dim disabled:cursor-default disabled:opacity-40"
            >
              {mutation.isPending ? 'Creating…' : 'Create task'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
