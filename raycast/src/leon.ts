import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { open, showToast, Toast } from "@raycast/api";

export type AlertKind = "needsYou" | "failed" | "finished";

export interface LeonAlert {
  id: string;
  kind: AlertKind;
  workspaceId: string;
  title: string;
  project: string;
  preview: string;
}

export interface WorkingAgent {
  terminalId: string;
  workspaceId: string;
  title: string;
  project: string;
}

export interface LeonState {
  alerts: LeonAlert[];
  working: WorkingAgent[];
  keepAwake: boolean;
  lidAwake: boolean;
  minimized: boolean;
}

export interface Worktree {
  id: string;
  name: string;
  branch: string;
  projectId: string;
  project: string;
  folder: string;
  folderColor: string;
  folderOrder: number;
  terminals: number;
  agent: "" | "needsYou" | "working" | "idle";
  uncommitted: number;
  exists: boolean;
}

export interface SupersetWorkspace {
  id: string;
  name: string;
  branch: string;
  type: string;
  path: string;
  project: string;
  folder: string;
  lastActivityAt: number;
  terminals: number;
  agent: "" | "needsYou" | "working" | "idle";
  pr: { number: number; state: "open" | "draft" | "merged" | "closed"; url: string } | null;
}

export interface WorktreeList {
  workspaces: Worktree[];
  progress: Record<string, string>;
  running: boolean;
}

export class LeonNotRunning extends Error {
  constructor() {
    super("Leon is not running");
  }
}

/** Leon rewrites the port and token on every launch, so read them per call. */
export async function leon<T>(path: string, body?: unknown): Promise<T> {
  let connection: { port: number; token: string };
  try {
    connection = JSON.parse(readFileSync(join(homedir(), ".leon", "avatar-api.json"), "utf8"));
  } catch {
    throw new LeonNotRunning();
  }
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${connection.port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new LeonNotRunning();
  }
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `Leon answered ${response.status}`);
  return json;
}

export function openWorkspace(workspaceId: string) {
  return open(`superset://v2-workspace/${workspaceId}`);
}

export function launchLeon() {
  execFile("open", ["-b", "ai.accomplish.leon.avatar"]);
}

export async function withToast(working: string, done: string, action: () => Promise<unknown>) {
  const toast = await showToast({ style: Toast.Style.Animated, title: working });
  try {
    await action();
    toast.style = Toast.Style.Success;
    toast.title = done;
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = (error as Error).message;
  }
}

export function teardownMessage(targets: Worktree[]): string {
  const lines = ["Leon sends /exit to each agent, exits each terminal, then deletes the worktrees. Branches are kept."];
  const dirty = targets.filter((worktree) => worktree.uncommitted > 0);
  if (dirty.length > 0) {
    lines.push(`Uncommitted changes will be lost in: ${dirty.map((worktree) => worktree.name).join(", ")}.`);
  }
  const working = targets.filter((worktree) => worktree.agent === "working" || worktree.agent === "needsYou");
  if (working.length > 0) lines.push(`${working.length} agent(s) still working will be stopped.`);
  return lines.join("\n\n");
}
