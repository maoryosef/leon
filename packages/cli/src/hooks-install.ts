import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { leonDataDir } from '@leon/core';

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

const LEON_HOOK_SCRIPT = `#!/bin/sh
# leon-hook — forwards Claude Code hook events to the Leon daemon.
# Written by \`leon install-hooks\`. Always exits 0: a dead daemon must
# never slow down or block a Claude session.
PAYLOAD=$(cat)
CONF="$HOME/.leon/config.toml"
TOKEN=$(sed -n 's/^token = "\\(.*\\)"$/\\1/p' "$CONF" 2>/dev/null | head -1)
PORT=$(sed -n 's/^port = \\([0-9]*\\)$/\\1/p' "$CONF" 2>/dev/null | head -1)
[ -z "$PORT" ] && PORT=5366
QS=""
[ -n "$LEON_SESSION_ID" ] && QS="leon_session_id=$LEON_SESSION_ID"
[ -n "$LEON_PANE_ID" ] && QS="$QS&leon_pane_id=$LEON_PANE_ID"
curl -s -m 2 -X POST "http://127.0.0.1:$PORT/hooks?$QS" \\
  -H "authorization: Bearer $TOKEN" \\
  -H "content-type: application/json" \\
  --data-binary "$PAYLOAD" >/dev/null 2>&1 || true
exit 0
`;

function hookEntry(command: string, event: string): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    hooks: [{ type: 'command', command }],
  };
  if (event === 'PreToolUse') entry.matcher = '*';
  return entry;
}

/**
 * Writes ~/.leon/bin/leon-hook + ~/.leon/child-hooks.json, and (optionally)
 * merges the hook entries into ~/.claude/settings.json so every Claude Code
 * session on the machine reports to Leon.
 */
export function installHooks(opts: { global: boolean }): void {
  const dataDir = leonDataDir();
  const binDir = join(dataDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const hookPath = join(binDir, 'leon-hook');
  writeFileSync(hookPath, LEON_HOOK_SCRIPT, { mode: 0o755 });
  chmodSync(hookPath, 0o755);
  console.log(`wrote ${hookPath}`);

  const hooksConfig: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) {
    hooksConfig[event] = [hookEntry(hookPath, event)];
  }
  const childSettingsPath = join(dataDir, 'child-hooks.json');
  writeFileSync(childSettingsPath, JSON.stringify({ hooks: hooksConfig }, null, 2));
  console.log(`wrote ${childSettingsPath} (pass to spawned sessions via --settings)`);

  if (!opts.global) {
    console.log('\nrun `leon install-hooks --global` to instrument ALL claude sessions');
    return;
  }

  const settingsPath = join(homedir(), '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const backup = `${settingsPath}.leon-backup-${Date.now()}`;
    copyFileSync(settingsPath, backup);
    console.log(`backed up ${settingsPath} → ${backup}`);
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  for (const event of HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const alreadyInstalled = JSON.stringify(existing).includes('leon-hook');
    if (!alreadyInstalled) {
      hooks[event] = [...existing, hookEntry(hookPath, event)];
    }
  }
  settings.hooks = hooks;
  mkdirSync(join(homedir(), '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`merged leon hooks into ${settingsPath}`);
  console.log('note: running claude sessions pick hooks up on their next restart');
}
