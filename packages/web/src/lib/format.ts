import type { Session } from '@leon/shared';

export function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Truncate the middle of long paths: /Users/x/…/projects/leon */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.floor((max - 1) / 2);
  const head = max - 1 - tail;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** tmux coordinates as users know them: sessionName:window.pane */
export function tmuxTarget(session: Session): string {
  return `${session.tmuxSessionName}:${session.tmuxWindowIndex}.${session.tmuxPaneId}`;
}

export function sessionTitle(session: Session): string {
  return session.title?.trim() ? session.title : basename(session.cwd);
}
