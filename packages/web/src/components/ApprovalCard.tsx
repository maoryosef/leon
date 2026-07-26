import type { Approval, DecideApprovalInput } from '@leon/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, decideApproval } from '../lib/api';
import { useNow } from '../lib/time';
import { applyApproval, removeApproval } from '../lib/ws-store';

const RISK_BORDER: Record<Approval['risk'], string> = {
  low: 'border-l-line-strong',
  medium: 'border-l-accent',
  high: 'border-l-danger',
};

function expiryMeta(expiresAt: string, now: number): { label: string; urgent: boolean } {
  const remaining = Math.floor((Date.parse(expiresAt) - now) / 1000);
  if (Number.isNaN(remaining)) return { label: '', urgent: false };
  if (remaining <= 0) return { label: 'expired', urgent: true };
  const urgent = remaining < 30;
  if (remaining < 60) return { label: `expires in ${remaining}s`, urgent };
  if (remaining < 3600) return { label: `expires in ${Math.floor(remaining / 60)}m`, urgent };
  return { label: `expires in ${Math.floor(remaining / 3600)}h`, urgent };
}

function prettyInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

/** One pending human-in-the-loop gate, pinned above the chat input. */
export function ApprovalCard({ approval }: { approval: Approval }) {
  const now = useNow(1000);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');

  const decide = useMutation({
    mutationFn: (input: DecideApprovalInput) => decideApproval(approval.id, input),
    // WS approval.resolved delivers the same thing — applyApproval is idempotent.
    onSuccess: applyApproval,
    onError: (error) => {
      // Already decided/expired (409) or unknown (404): drop the card and let
      // the WS event reconcile. Other failures keep it so the user can retry.
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        removeApproval(approval.id);
      }
    },
  });

  const expiry = expiryMeta(approval.expiresAt, now);

  const confirmDeny = () => {
    if (decide.isPending) return;
    const trimmed = reason.trim();
    decide.mutate({ approve: false, ...(trimmed ? { reason: trimmed } : {}) });
  };

  return (
    <div
      className={`border border-line border-l-2 bg-raise px-2.5 py-2 ${RISK_BORDER[approval.risk]}`}
    >
      <div className="flex items-center gap-2">
        <span className="max-w-[60%] truncate border border-line bg-bg px-1.5 py-0.5 font-mono text-[10.5px] text-txt">
          ⚡ {approval.toolName}
        </span>
        <span
          className={`ml-auto shrink-0 font-mono text-[10px] ${
            expiry.urgent ? 'text-danger' : 'text-faint'
          }`}
        >
          {expiry.label}
        </span>
      </div>

      <p className="mt-1.5 text-[12.5px] leading-snug text-txt">{approval.summary}</p>

      <details className="mt-1">
        <summary className="cursor-pointer select-none font-mono text-[10px] text-faint hover:text-dim">
          input
        </summary>
        <pre className="mt-1 max-h-32 overflow-auto border border-line bg-bg p-1.5 font-mono text-[10px] leading-snug text-dim">
          {prettyInput(approval.toolInput)}
        </pre>
      </details>

      {decide.isError &&
        !(
          decide.error instanceof ApiError &&
          (decide.error.status === 404 || decide.error.status === 409)
        ) && (
          <p className="mt-1.5 font-mono text-[10.5px] text-danger">
            decision failed — try again
          </p>
        )}

      {denying ? (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            autoFocus
            value={reason}
            disabled={decide.isPending}
            placeholder="why? (optional, Leon reads this)"
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                confirmDeny();
              } else if (event.key === 'Escape') {
                setDenying(false);
                setReason('');
              }
            }}
            className="min-w-0 flex-1 border border-line bg-bg px-1.5 py-1 font-mono text-[11px] text-txt placeholder:text-faint outline-none focus:border-line-strong"
          />
          <button
            type="button"
            onClick={confirmDeny}
            disabled={decide.isPending}
            className="shrink-0 border border-danger/60 bg-raise px-2 py-1 text-[11px] font-medium text-danger hover:border-danger disabled:cursor-default disabled:opacity-40"
          >
            {decide.isPending ? '…' : 'Deny'}
          </button>
          <button
            type="button"
            title="Cancel"
            onClick={() => {
              setDenying(false);
              setReason('');
            }}
            disabled={decide.isPending}
            className="shrink-0 border border-line px-2 py-1 text-[11px] text-dim hover:border-line-strong hover:text-txt disabled:cursor-default disabled:opacity-40"
          >
            ✕
          </button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => decide.mutate({ approve: true })}
            disabled={decide.isPending}
            className="border border-accent/60 bg-accent/15 px-2.5 py-1 text-[11px] font-medium text-accent hover:border-accent hover:bg-accent/25 disabled:cursor-default disabled:opacity-40"
          >
            {decide.isPending ? '…' : 'Approve'}
          </button>
          <button
            type="button"
            onClick={() => setDenying(true)}
            disabled={decide.isPending}
            className="border border-line-strong px-2.5 py-1 text-[11px] text-dim hover:border-danger hover:text-danger disabled:cursor-default disabled:opacity-40"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
