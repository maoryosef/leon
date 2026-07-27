import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface RemoteMcpSpec {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

/**
 * Reads a user-level MCP server spec from ~/.claude.json (the store
 * `claude mcp add -s user` writes to). Only remote servers pass through —
 * Leon mounts them into its own agent, reusing the CLI's OAuth token store,
 * so whatever the user authenticated in Claude Code works inside Leon too.
 */
export function loadUserMcpServer(name: string): RemoteMcpSpec | null {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, { type?: string; url?: string; headers?: Record<string, string> }>;
    };
    const spec = cfg.mcpServers?.[name];
    if (!spec?.url || (spec.type !== 'http' && spec.type !== 'sse')) return null;
    return { type: spec.type, url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) };
  } catch {
    return null;
  }
}
