import { Action, ActionPanel, Alert, Color, confirmAlert, Icon, List, showToast, Toast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { setTimeout as sleep } from "node:timers/promises";
import { leon, LeonNotRunning, openWorkspace, SupersetWorkspace, teardownMessage, WorktreeList } from "./leon";
import { NotRunning } from "./not-running";

const AGENT_TAGS: Record<string, { value: string; color: Color }> = {
  needsYou: { value: "needs you", color: Color.Orange },
  working: { value: "working", color: Color.Green },
  idle: { value: "idle", color: Color.Blue },
};

async function teardown(workspace: SupersetWorkspace) {
  const before = await leon<WorktreeList>("/workspaces");
  const target = before.workspaces.find((worktree) => worktree.id === workspace.id);
  if (!target) {
    await showToast({ style: Toast.Style.Failure, title: "Only worktrees can be torn down" });
    return false;
  }
  if (before.running) {
    await showToast({ style: Toast.Style.Failure, title: "A cleanup is already running" });
    return false;
  }
  const confirmed = await confirmAlert({
    title: `Delete ${workspace.name}?`,
    message: teardownMessage([target]),
    icon: Icon.Trash,
    primaryAction: { title: "Exit & Delete", style: Alert.ActionStyle.Destructive },
  });
  if (!confirmed) return false;

  const toast = await showToast({ style: Toast.Style.Animated, title: "Tearing down", message: workspace.name });
  try {
    await leon("/workspaces/delete", { ids: [workspace.id] });
    let status: WorktreeList;
    do {
      await sleep(1000);
      status = await leon<WorktreeList>("/workspaces");
      toast.message = status.progress[workspace.id] ?? workspace.name;
    } while (status.running);
    const result = status.progress[workspace.id] ?? "";
    toast.style = result.startsWith("Failed") ? Toast.Style.Failure : Toast.Style.Success;
    toast.title = result.startsWith("Failed") ? "Teardown failed" : "Workspace deleted";
    toast.message = result.startsWith("Failed") ? result : workspace.name;
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = (error as Error).message;
  }
  return true;
}

const PR_COLORS: Record<string, Color> = {
  merged: Color.Purple,
  open: Color.Green,
  draft: Color.SecondaryText,
  closed: Color.Red,
};

export default function Workspaces() {
  const { data, isLoading, error, revalidate } = usePromise(() => leon<SupersetWorkspace[]>("/workspaces/open"));

  if (error instanceof LeonNotRunning) return <NotRunning onLaunched={revalidate} />;

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Jump to a Superset workspace">
      {data?.map((workspace) => {
        const agentTag = AGENT_TAGS[workspace.agent];
        return (
          <List.Item
            key={workspace.id}
            icon={workspace.type === "local" ? Icon.House : Icon.Tree}
            title={workspace.name}
            subtitle={workspace.project}
            keywords={[workspace.project, workspace.branch, workspace.folder, workspace.pr?.state ?? ""]}
            accessories={[
              ...(workspace.pr
                ? [
                    {
                      tag: { value: `PR #${workspace.pr.number} ${workspace.pr.state}`, color: PR_COLORS[workspace.pr.state] },
                      tooltip: workspace.pr.state === "merged" ? "Merged: safe to tear down" : undefined,
                    },
                  ]
                : []),
              ...(agentTag ? [{ tag: agentTag }] : []),
              ...(workspace.folder ? [{ tag: { value: workspace.folder, color: Color.SecondaryText }, icon: Icon.Folder }] : []),
              { date: new Date(workspace.lastActivityAt), tooltip: "Last activity" },
            ]}
            actions={
              <ActionPanel>
                <Action title="Open in Superset" icon={Icon.ArrowRight} onAction={() => openWorkspace(workspace.id)} />
                {workspace.pr && (
                  <Action.OpenInBrowser
                    title="Open Pull Request"
                    url={workspace.pr.url}
                    shortcut={{ modifiers: ["cmd"], key: "o" }}
                  />
                )}
                <Action.ShowInFinder path={workspace.path} shortcut={{ modifiers: ["cmd"], key: "f" }} />
                {workspace.type === "worktree" && (
                  <Action
                    title="Exit & Delete Workspace"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }}
                    onAction={async () => {
                      if (await teardown(workspace)) revalidate();
                    }}
                  />
                )}
                <Action.CopyToClipboard
                  title="Copy Branch"
                  content={workspace.branch}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                />
                <Action.CopyToClipboard
                  title="Copy Path"
                  content={workspace.path}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "." }}
                />
                <Action
                  title="Refresh"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                  onAction={revalidate}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
