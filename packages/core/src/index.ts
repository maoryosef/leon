import { LeonAgent } from './agent/leon-agent.js';
import { loadConfig, type LeonConfig } from './config.js';
import { openDb, type LeonDb } from './db/index.js';
import { EventBus } from './events.js';
import { Monitor } from './monitor/monitor.js';
import { ChatService } from './services/chat-service.js';
import { PrPoller } from './services/pr-service.js';
import { SessionService } from './services/session-service.js';
import { TaskService } from './services/task-service.js';
import { Tmux } from './tmux/tmux.js';

export interface LeonCore {
  config: LeonConfig;
  db: LeonDb;
  bus: EventBus;
  tmux: Tmux;
  sessions: SessionService;
  tasks: TaskService;
  monitor: Monitor;
  prs: PrPoller;
  chat: ChatService;
  agent: LeonAgent;
  start(): Promise<void>;
  stop(): void;
}

export function createCore(config: LeonConfig = loadConfig()): LeonCore {
  const db = openDb(config.dbPath);
  const bus = new EventBus();
  const tmux = new Tmux();
  const sessions = new SessionService(db, bus);
  const tasks = new TaskService(db, bus);
  const monitor = new Monitor(tmux, sessions, bus, {
    pollMs: config.discovery.pollMs,
    scrapeMs: config.discovery.scrapeMs,
  });
  const prs = new PrPoller(db, bus, sessions, config.discovery.prPollMs);
  const chat = new ChatService(db, bus);
  const agent = new LeonAgent(config, bus, chat, { sessions, tasks, prs, tmux });

  return {
    config,
    db,
    bus,
    tmux,
    sessions,
    tasks,
    monitor,
    prs,
    chat,
    agent,
    async start() {
      await monitor.start();
      prs.start();
      agent.start();
    },
    stop() {
      agent.stop();
      monitor.stop();
      prs.stop();
      db.close();
    },
  };
}

export { loadConfig, expandTilde, leonDataDir, type LeonConfig } from './config.js';
export { openDb, type LeonDb } from './db/index.js';
export { EventBus } from './events.js';
export { Monitor } from './monitor/monitor.js';
export { StatusEngine, type StatusSignal } from './monitor/status-engine.js';
export { statusFromPaneContent } from './monitor/pane-heuristics.js';
export { statusFromHook } from './monitor/hook-signals.js';
export { interpretTranscriptLine, TranscriptTailer } from './monitor/transcript-tailer.js';
export { encodeProjectDir, findTranscripts, projectsRoot } from './monitor/transcripts.js';
export { LeonAgent } from './agent/leon-agent.js';
export { composeSystemPrompt } from './agent/prompt.js';
export { ChatService } from './services/chat-service.js';
export { SessionService } from './services/session-service.js';
export { TaskService } from './services/task-service.js';
export { PrPoller } from './services/pr-service.js';
export { Tmux, parsePaneLine, type TmuxPane } from './tmux/tmux.js';
export { findClaudeDescendant, processSnapshot, isClaudeCommand } from './tmux/processes.js';
export { approvalFromRow, prFromRow, sessionFromRow, taskFromRow } from './db/rows.js';
