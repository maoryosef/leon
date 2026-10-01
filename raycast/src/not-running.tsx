import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { launchLeon } from "./leon";

export function NotRunning({ onLaunched }: { onLaunched: () => void }) {
  return (
    <List>
      <List.EmptyView
        icon="leon.png"
        title="Leon is not running"
        description="Press Enter to launch the Leon avatar app."
        actions={
          <ActionPanel>
            <Action
              title="Launch Leon"
              icon={Icon.Play}
              onAction={() => {
                launchLeon();
                setTimeout(onLaunched, 2500);
              }}
            />
          </ActionPanel>
        }
      />
    </List>
  );
}
