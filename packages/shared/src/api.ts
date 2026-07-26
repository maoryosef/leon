import { z } from 'zod';
import { TaskStatus } from './domain.js';

export const CreateTaskInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  jiraKey: z.string().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

export const UpdateTaskInput = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  status: TaskStatus.optional(),
  jiraKey: z.string().nullable().optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;

export const LinkSessionInput = z.object({
  taskId: z.string().nullable(), // null unlinks (back to Inbox)
});
export type LinkSessionInput = z.infer<typeof LinkSessionInput>;

export const UpdateSessionInput = z.object({
  title: z.string().nullable().optional(),
});
export type UpdateSessionInput = z.infer<typeof UpdateSessionInput>;
