import type { HookPayload, SessionStatus } from '@leon/shared';

/**
 * Maps a Claude Code hook event to a session status. Hooks are the
 * highest-trust signal tier.
 */
export function statusFromHook(
  payload: HookPayload,
): { status: SessionStatus; activity?: string | null } | null {
  switch (payload.hook_event_name) {
    case 'SessionStart':
      // claude just opened; it is waiting for (or about to receive) a prompt
      return { status: 'waiting_input', activity: null };
    case 'UserPromptSubmit':
      return { status: 'working', activity: null };
    case 'PreToolUse':
    case 'PostToolUse':
      return { status: 'working', activity: payload.tool_name ?? null };
    case 'Notification': {
      const msg = payload.message ?? '';
      const isPermission = /permission|approval|approve|allow/i.test(msg);
      return { status: isPermission ? 'waiting_permission' : 'waiting_input' };
    }
    case 'Stop':
      return { status: 'idle_done', activity: null };
    case 'SubagentStop':
      return null; // parent agent is still mid-turn
    case 'SessionEnd':
      return { status: 'dead' };
    default:
      return null;
  }
}
