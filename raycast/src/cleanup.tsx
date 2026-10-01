import { Action, ActionPanel, Alert, Color, confirmAlert, Icon, List } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useEffect, useMemo, useState } from "react";
import { leon, LeonNotRunning, teardownMessage, withToast, Worktree, WorktreeList } from "./leon";
import { NotRunning } from "./not-running";

interface Group {
  key: string;
  title: string;
  projectId: string;
  items: Worktree[];
}

function groupWorktrees(worktrees: Worktree[]): Group[] {
  const groups = new Map<string, Group>();
  for (const worktree of worktrees) {
    const key = `${worktree.projectId}/${worktree.folder}`;
    const group = groups.get(key) ?? {
      key,
      title: `${worktree.project} › ${worktree.folder || "No folder"}`,
      projectId: worktree.projectId,
      items: [],
    };
    group.items.push(worktree);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    const left = a.items[0];
    const right = b.items[0];
    return (
      left.project.localeCompare(right.project) ||
      Number(!left.folder) - Number(!right.folder) ||
      left.folderOrder - right.folderOrder ||
      left.folder.localeCompare(right.folder)
    );
  });
}

const AGENT_TAGS: Record<string, { value: string; color: Color }> = {
  needsYou: { value: "agent needs you", color: Color.Orange },
  working: { value: "agent working", color: Color.Green },
  idle: { value: "agent idle", color: Color.Blue },
};

export default function Cleanup() {
  const { data, isLoading, error, revalidate } = usePromise(() => leon<WorktreeList>("/workspaces"));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const groups = useMemo(() => groupWorktrees(data?.workspaces ?? []), [data]);

  useEffect(() => {
    if (!data?.running) return;
    const timer = setInterval(revalidate, 1500);
    return () => clearInterval(timer);
  }, [data?.running, revalidate]);

  if (error instanceof LeonNotRunning) return <NotRunning onLaunched={revalidate} />;

  const toggle = (ids: string[]) =>
    setSelected((current) => {
      const next = new Set(current);
      const allOn = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const deleteSelected = async () => {
    const targets = data?.workspaces.filter((worktree) => selected.has(worktree.id)) ?? [];
    if (targets.length === 0) return;
    const confirmed = await confirmAlert({
      title: `Delete ${targets.length} worktree${targets.length === 1 ? "" : "s"}?`,
      message: teardownMessage(targets),
      icon: Icon.Trash,
      primaryAction: { title: "Exit & Delete", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    await withToast("Starting cleanup…", "Cleanup started", () =>
      leon("/workspaces/delete", { ids: targets.map((worktree) => worktree.id) }),
    );
    setSelected(new Set());
    revalidate();
  };

  const busy = data?.running ?? false;

  return (
    <List
      isLoading={isLoading || busy}
      navigationTitle={busy ? "Cleaning up…" : `${selected.size} selected`}
      searchBarPlaceholder="Filter worktrees"
    >
      {groups.map((group) => {
        const groupIds = group.items.map((worktree) => worktree.id);
        const projectIds =
          data?.workspaces.filter((worktree) => worktree.projectId === group.projectId).map((worktree) => worktree.id) ?? [];
        return (
          <List.Section key={group.key} title={group.title} subtitle={`${group.items.length}`}>
            {group.items.map((worktree) => {
              const isSelected = selected.has(worktree.id);
              const progress = data?.progress[worktree.id];
              const agentTag = AGENT_TAGS[worktree.agent];
              return (
                <List.Item
                  key={worktree.id}
                  icon={
                    isSelected
                      ? { source: Icon.CheckCircle, tintColor: Color.Blue }
                      : { source: Icon.Circle, tintColor: Color.SecondaryText }
                  }
                  title={worktree.name}
                  subtitle={worktree.branch}
                  keywords={[worktree.project, worktree.folder, worktree.branch]}
                  accessories={[
                    ...(progress
                      ? [{ tag: { value: progress, color: progress.startsWith("Failed") ? Color.Red : Color.Purple } }]
                      : []),
                    ...(worktree.uncommitted > 0
                      ? [{ tag: { value: `${worktree.uncommitted} uncommitted`, color: Color.Red } }]
                      : []),
                    ...(agentTag ? [{ tag: agentTag }] : []),
                    ...(worktree.exists ? [] : [{ tag: { value: "missing on disk", color: Color.SecondaryText } }]),
                    { text: `${worktree.terminals}`, icon: Icon.Terminal, tooltip: "Open terminals" },
                  ]}
                  actions={
                    <ActionPanel>
                      <Action
                        title={isSelected ? "Deselect" : "Select"}
                        icon={isSelected ? Icon.Circle : Icon.CheckCircle}
                        onAction={() => toggle([worktree.id])}
                      />
                      <Action
                        title="Toggle Whole Folder"
                        icon={Icon.Folder}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
                        onAction={() => toggle(groupIds)}
                      />
                      <Action
                        title="Toggle Whole Project"
                        icon={Icon.Layers}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
                        onAction={() => toggle(projectIds)}
                      />
                      <ActionPanel.Section>
                        <Action
                          title={`Exit & Delete ${selected.size} Selected`}
                          icon={Icon.Trash}
                          style={Action.Style.Destructive}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }}
                          onAction={deleteSelected}
                        />
                        <Action
                          title="Clear Selection"
                          icon={Icon.XMarkCircle}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "x" }}
                          onAction={() => setSelected(new Set())}
                        />
                        <Action
                          title="Refresh"
                          icon={Icon.ArrowClockwise}
                          shortcut={{ modifiers: ["cmd"], key: "r" }}
                          onAction={revalidate}
                        />
                      </ActionPanel.Section>
                    </ActionPanel>
                  }
                />
              );
            })}
          </List.Section>
        );
      })}
    </List>
  );
}
