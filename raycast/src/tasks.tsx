import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useEffect } from "react";
import Cleanup from "./cleanup";
import { AlertKind, leon, LeonAlert, LeonNotRunning, LeonState, openWorkspace, withToast } from "./leon";
import { NotRunning } from "./not-running";

const SECTIONS: { kind: AlertKind; title: string; icon: Icon; color: Color }[] = [
  { kind: "needsYou", title: "Needs You", icon: Icon.ExclamationMark, color: Color.Orange },
  { kind: "failed", title: "Failed", icon: Icon.XMarkCircle, color: Color.Red },
  { kind: "finished", title: "Finished", icon: Icon.CheckCircle, color: Color.Green },
];

export default function Tasks() {
  const { data, isLoading, error, revalidate } = usePromise(() => leon<LeonState>("/state"));

  useEffect(() => {
    const timer = setInterval(revalidate, 3000);
    return () => clearInterval(timer);
  }, [revalidate]);

  if (error instanceof LeonNotRunning) return <NotRunning onLaunched={revalidate} />;

  const act = (working: string, done: string, action: () => Promise<unknown>) =>
    withToast(working, done, action).then(revalidate);

  const setting = (body: Partial<LeonState>, working: string, done: string) =>
    act(working, done, async () => {
      const next = await leon<LeonState>("/settings", body);
      const unchanged = (Object.keys(body) as (keyof LeonState)[]).some((key) => next[key] !== body[key]);
      if (unchanged) throw new Error("Setting unchanged");
    });

  const shared = (
    <ActionPanel.Section>
      <Action
        title="Clear All Alerts"
        icon={Icon.Trash}
        shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }}
        onAction={() => act("Clearing…", "Alerts cleared", () => leon("/alerts/clear", {}))}
      />
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ["cmd"], key: "r" }}
        onAction={revalidate}
      />
    </ActionPanel.Section>
  );

  const alertActions = (alert: LeonAlert) => (
    <ActionPanel>
      <Action
        title="Open in Superset"
        icon={Icon.ArrowRight}
        onAction={() =>
          act("Opening…", "Opened in Superset", async () => {
            await openWorkspace(alert.workspaceId);
            await leon(`/alerts/${alert.id}/dismiss`, {});
          })
        }
      />
      <Action
        title="Dismiss"
        icon={Icon.XMarkCircle}
        shortcut={{ modifiers: ["cmd"], key: "d" }}
        onAction={() => act("Dismissing…", "Dismissed", () => leon(`/alerts/${alert.id}/dismiss`, {}))}
      />
      {alert.preview && (
        <Action.CopyToClipboard
          title="Copy Agent Message"
          content={alert.preview}
          shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
        />
      )}
      {shared}
    </ActionPanel>
  );

  const toggleItem = (title: string, on: boolean, icon: Icon, toggle: () => void) => (
    <List.Item
      title={title}
      icon={icon}
      accessories={[{ tag: on ? { value: "On", color: Color.Green } : { value: "Off", color: Color.SecondaryText } }]}
      actions={
        <ActionPanel>
          <Action title={on ? "Turn Off" : "Turn On"} icon={Icon.Switch} onAction={toggle} />
          {shared}
        </ActionPanel>
      }
    />
  );

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter tasks">
      {SECTIONS.map(({ kind, title, icon, color }) => {
        const alerts = data?.alerts.filter((alert) => alert.kind === kind) ?? [];
        if (alerts.length === 0) return null;
        return (
          <List.Section key={kind} title={title} subtitle={`${alerts.length}`}>
            {alerts.map((alert) => (
              <List.Item
                key={alert.id}
                icon={{ source: icon, tintColor: color }}
                title={alert.title}
                subtitle={alert.project}
                keywords={[alert.project, alert.preview]}
                accessories={alert.preview ? [{ text: alert.preview, tooltip: alert.preview }] : []}
                actions={alertActions(alert)}
              />
            ))}
          </List.Section>
        );
      })}

      {data && data.working.length > 0 && (
        <List.Section title="Working" subtitle={`${data.working.length}`}>
          {data.working.map((agent) => (
            <List.Item
              key={agent.terminalId}
              icon={{ source: Icon.CircleProgress50, tintColor: Color.Blue }}
              title={agent.title}
              subtitle={agent.project}
              actions={
                <ActionPanel>
                  <Action
                    title="Open in Superset"
                    icon={Icon.ArrowRight}
                    onAction={() => openWorkspace(agent.workspaceId)}
                  />
                  {shared}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {data && (
        <List.Section title="Leon">
          {toggleItem("Keep Mac Awake", data.keepAwake, Icon.Mug, () =>
            setting({ keepAwake: !data.keepAwake }, "Switching…", data.keepAwake ? "Mac can sleep" : "Keeping the Mac awake"),
          )}
          {toggleItem("Stay Awake With Lid Closed", data.lidAwake, Icon.Monitor, () =>
            setting(
              { lidAwake: !data.lidAwake },
              "Waiting for your password…",
              data.lidAwake ? "Sleep is back on" : "Sleep is off, even with the lid closed",
            ),
          )}
          {toggleItem("Minimize Leon", data.minimized, Icon.Minimize, () =>
            setting({ minimized: !data.minimized }, "Switching…", data.minimized ? "Leon is back" : "Leon minimized"),
          )}
          <List.Item
            title="Clean Up Workspaces"
            icon={Icon.Trash}
            actions={
              <ActionPanel>
                <Action.Push title="Open Clean Up" icon={Icon.Trash} target={<Cleanup />} />
              </ActionPanel>
            }
          />
        </List.Section>
      )}
    </List>
  );
}
