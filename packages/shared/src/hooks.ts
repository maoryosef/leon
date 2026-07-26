import { z } from 'zod';

/**
 * Payload POSTed by the `leon-hook` script from child Claude Code sessions.
 *
 * Claude Code writes a JSON object to the hook's stdin containing at least
 * `session_id`, `transcript_path`, `cwd` and `hook_event_name`, plus
 * event-specific fields. The script forwards it verbatim and adds the
 * LEON_* env vars when present (set for sessions Leon spawned).
 * The schema is deliberately loose — unknown fields pass through.
 */
export const HookEventName = z.enum([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionEnd',
]);
export type HookEventName = z.infer<typeof HookEventName>;

export const HookPayload = z
  .object({
    session_id: z.string(),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
    hook_event_name: HookEventName,
    // PreToolUse / PostToolUse
    tool_name: z.string().optional(),
    tool_input: z.unknown().optional(),
    // Notification
    message: z.string().optional(),
    // injected by leon-hook when Leon spawned the session
    leon_session_id: z.string().optional(),
    leon_pane_id: z.string().optional(),
  })
  .loose();
export type HookPayload = z.infer<typeof HookPayload>;
