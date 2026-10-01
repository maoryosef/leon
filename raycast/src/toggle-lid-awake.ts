import { showHUD } from "@raycast/api";
import { leon, LeonNotRunning, LeonState } from "./leon";

export default async function ToggleLidAwake() {
  try {
    const state = await leon<LeonState>("/state");
    const next = await leon<LeonState>("/settings", { lidAwake: !state.lidAwake });
    if (next.lidAwake === state.lidAwake) {
      await showHUD("Sleep setting unchanged");
    } else {
      await showHUD(next.lidAwake ? "Sleep is off, even with the lid closed" : "Sleep is back on");
    }
  } catch (error) {
    await showHUD(error instanceof LeonNotRunning ? error.message : `Failed: ${(error as Error).message}`);
  }
}
