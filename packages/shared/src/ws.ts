import { z } from 'zod';
import { Approval, ChatMessage, PullRequest, Session, Task } from './domain.js';

/**
 * Events pushed by the daemon over /ws/events. Clients receive a full
 * `snapshot` on connect, then incremental events.
 */
export const WsEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    tasks: z.array(Task),
    sessions: z.array(Session),
    pullRequests: z.array(PullRequest),
    approvals: z.array(Approval),
  }),
  z.object({ type: z.literal('task.upserted'), task: Task }),
  z.object({ type: z.literal('task.deleted'), taskId: z.string() }),
  z.object({ type: z.literal('session.upserted'), session: Session }),
  z.object({
    type: z.literal('session.status'),
    sessionId: z.string(),
    session: Session,
  }),
  z.object({ type: z.literal('pr.upserted'), pullRequest: PullRequest }),
  z.object({ type: z.literal('pr.deleted'), pullRequestId: z.string() }),
  z.object({ type: z.literal('approval.requested'), approval: Approval }),
  z.object({ type: z.literal('approval.resolved'), approval: Approval }),
  z.object({ type: z.literal('chat.message'), message: ChatMessage }),
  z.object({
    type: z.literal('chat.delta'),
    messageId: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('chat.status'),
    state: z.enum(['thinking', 'idle', 'error']),
    detail: z.string().nullish(),
  }),
]);
export type WsEvent = z.infer<typeof WsEvent>;
