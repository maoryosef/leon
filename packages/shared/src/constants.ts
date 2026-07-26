/**
 * Prefix for the disposable grouped tmux sessions the daemon creates for
 * web peek/attach terminals. Discovery must ignore panes seen through these
 * sessions: grouped sessions share windows, so every claude pane would
 * otherwise appear twice in `list-panes -a` and poison the stored
 * tmuxSessionName (which then breaks attach with a phantom new session).
 */
export const VIEW_SESSION_PREFIX = 'leon-view-';
