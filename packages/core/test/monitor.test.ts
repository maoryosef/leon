import { describe, expect, it } from 'vitest';
import { statusFromPaneContent } from '../src/monitor/pane-heuristics.js';
import { StatusEngine, type StatusSignal } from '../src/monitor/status-engine.js';
import { interpretTranscriptLine } from '../src/monitor/transcript-tailer.js';
import { encodeProjectDir } from '../src/monitor/transcripts.js';
import { statusFromHook } from '../src/monitor/hook-signals.js';
import { parsePaneLine } from '../src/tmux/tmux.js';
import { findClaudeDescendant } from '../src/tmux/processes.js';

describe('parsePaneLine', () => {
  it('parses a tmux list-panes formatted line', () => {
    const pane = parsePaneLine(
      '%42\titerm_1785053264\t0\t1\t61571\t/Users/x/projects/leon\tclaude',
    );
    expect(pane).toEqual({
      paneId: '%42',
      sessionName: 'iterm_1785053264',
      windowIndex: 0,
      paneIndex: 1,
      panePid: 61571,
      currentPath: '/Users/x/projects/leon',
      currentCommand: 'claude',
    });
  });

  it('rejects malformed lines', () => {
    expect(parsePaneLine('garbage')).toBeNull();
    expect(parsePaneLine('notpane\ts\t0\t0\t1\t/x\tzsh')).toBeNull();
  });
});

describe('encodeProjectDir', () => {
  it('replaces slashes and dots with dashes (verified against live dirs)', () => {
    expect(encodeProjectDir('/Users/maoryosef/projects/leon')).toBe(
      '-Users-maoryosef-projects-leon',
    );
    expect(encodeProjectDir('/Users/maoryosef/.superset/worktrees/a')).toBe(
      '-Users-maoryosef--superset-worktrees-a',
    );
  });
});

describe('findClaudeDescendant', () => {
  const procs = [
    { pid: 100, ppid: 1, command: '/bin/zsh' },
    { pid: 200, ppid: 100, command: 'node' },
    { pid: 300, ppid: 200, command: '/opt/homebrew/bin/claude' },
    { pid: 400, ppid: 1, command: 'claude' },
  ];
  it('finds claude through a wrapper process', () => {
    expect(findClaudeDescendant(100, procs)?.pid).toBe(300);
  });
  it('returns null when no claude in subtree', () => {
    expect(findClaudeDescendant(400, procs)).toBeNull(); // 400 IS claude but has no descendants
  });
});

describe('pane heuristics (fixtures from live Claude Code panes, 2026-07)', () => {
  it('detects a permission prompt', () => {
    const capture = [
      ' Bash command',
      '',
      '   grep -rn "foo" .',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, allow reading from x/',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend · ctrl+e to explain',
    ].join('\n');
    expect(statusFromPaneContent(capture)).toBe('waiting_permission');
  });

  it('detects working via esc to interrupt', () => {
    const capture = '✻ Cogitating… (32s · ↑ 1.2k tokens · esc to interrupt)';
    expect(statusFromPaneContent(capture)).toBe('working');
  });

  it('detects an idle prompt', () => {
    const capture = [
      '✻ Baked for 3m 1s',
      '───────────────────────',
      '❯ ',
      '───────────────────────',
      '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n');
    expect(statusFromPaneContent(capture)).toBe('idle_done');
  });

  it('returns null on unrecognized content', () => {
    expect(statusFromPaneContent('just a shell\n$ ls\nfile.txt')).toBeNull();
  });
});

describe('statusFromHook', () => {
  const base = { session_id: 'abc', hook_event_name: 'Stop' } as const;
  it('maps events to statuses', () => {
    expect(statusFromHook({ ...base, hook_event_name: 'Stop' })?.status).toBe('idle_done');
    expect(statusFromHook({ ...base, hook_event_name: 'UserPromptSubmit' })?.status).toBe(
      'working',
    );
    expect(
      statusFromHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
    ).toEqual({ status: 'working', activity: 'Bash' });
    expect(
      statusFromHook({
        ...base,
        hook_event_name: 'Notification',
        message: 'Claude needs your permission to use Bash',
      })?.status,
    ).toBe('waiting_permission');
    expect(
      statusFromHook({
        ...base,
        hook_event_name: 'Notification',
        message: 'Claude is waiting for your input',
      })?.status,
    ).toBe('waiting_input');
    expect(statusFromHook({ ...base, hook_event_name: 'SubagentStop' })).toBeNull();
  });
});

describe('interpretTranscriptLine', () => {
  it('extracts tool activity from assistant tool_use', () => {
    const event = interpretTranscriptLine({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    });
    expect(event?.signal.status).toBe('working');
    expect(event?.signal.activity).toBe('Bash');
  });
  it('ignores unknown record types', () => {
    expect(interpretTranscriptLine({ type: 'summary' })).toBeNull();
    expect(interpretTranscriptLine('not an object')).toBeNull();
  });
});

describe('StatusEngine merge', () => {
  function makeEngine() {
    const applied: { status: string; source: string }[] = [];
    const engine = new StatusEngine((_id, status, source) => {
      applied.push({ status, source });
    });
    return { engine, applied };
  }
  const sig = (over: Partial<StatusSignal>): StatusSignal => ({
    sessionId: 's1',
    status: 'working',
    source: 'scrape',
    at: new Date().toISOString(),
    ...over,
  });

  it('fresh hook beats fresh scrape', () => {
    const { engine, applied } = makeEngine();
    engine.ingest(sig({ source: 'hook', status: 'idle_done' }));
    engine.ingest(sig({ source: 'scrape', status: 'working' }));
    expect(applied.at(-1)).toEqual({ status: 'idle_done', source: 'hook' });
  });

  it('scrape wins once hook signal is stale', () => {
    const { engine, applied } = makeEngine();
    const stale = new Date(Date.now() - 11 * 60_000).toISOString();
    engine.ingest(sig({ source: 'hook', status: 'idle_done', at: stale }));
    engine.ingest(sig({ source: 'scrape', status: 'waiting_permission' }));
    expect(applied.at(-1)).toEqual({ status: 'waiting_permission', source: 'scrape' });
  });

  it('dead is definitive and clears state', () => {
    const { engine, applied } = makeEngine();
    engine.ingest(sig({ source: 'hook', status: 'working' }));
    engine.ingest(sig({ source: 'tmux', status: 'dead' }));
    expect(applied.at(-1)).toEqual({ status: 'dead', source: 'tmux' });
    expect(engine.needsScrape('s1')).toBe(true); // signal map cleared
  });

  it('needsScrape is false while transcript signal is fresh', () => {
    const { engine } = makeEngine();
    engine.ingest(sig({ source: 'transcript', status: 'working' }));
    expect(engine.needsScrape('s1')).toBe(false);
  });
});
