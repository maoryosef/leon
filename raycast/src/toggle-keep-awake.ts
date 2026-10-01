import { showHUD } from "@raycast/api";
import { leon, LeonNotRunning, LeonState } from "./leon";

export default async function ToggleKeepAwake() {
  try {
    const state = await leon<LeonState>("/state");
    const next = await leon<LeonState>("/settings", { keepAwake: !state.keepAwake });
    await showHUD(next.keepAwake ? "Keeping the Mac awake" : "The Mac can sleep again");
  } catch (error) {
    await showHUD(error instanceof LeonNotRunning ? error.message : `Failed: ${(error as Error).message}`);
  }
}
