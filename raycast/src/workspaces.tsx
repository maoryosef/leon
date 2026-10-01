import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { leon, LeonNotRunning, openWorkspace, SupersetWorkspace } from "./leon";
import { NotRunning } from "./not-running";

const AGENT_TAGS: Record<string, { value: string; color: Color }> = {
  needsYou: { value: "needs you", color: Color.Orange },
  working: { value: "working", color: Color.Green },
  idle: { value: "idle", color: Color.Blue },
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
            keywords={[workspace.project, workspace.branch, workspace.folder]}
            accessories={[
              ...(agentTag ? [{ tag: agentTag }] : []),
              ...(workspace.folder ? [{ tag: { value: workspace.folder, color: Color.SecondaryText }, icon: Icon.Folder }] : []),
              { date: new Date(workspace.lastActivityAt), tooltip: "Last activity" },
            ]}
            actions={
              <ActionPanel>
                <Action title="Open in Superset" icon={Icon.ArrowRight} onAction={() => openWorkspace(workspace.id)} />
                <Action.ShowInFinder path={workspace.path} shortcut={{ modifiers: ["cmd"], key: "f" }} />
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
