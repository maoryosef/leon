import { LeonAgent } from './agent/leon-agent.js';
import { ApprovalTracker } from './agent/tools.js';
import { loadConfig, type LeonConfig } from './config.js';
import { openDb, type LeonDb } from './db/index.js';
import { EventBus } from './events.js';
import { Monitor } from './monitor/monitor.js';
import { ApprovalService } from './services/approval-service.js';
import { ChatService } from './services/chat-service.js';
import { NotificationService } from './services/notification-service.js';
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
  approvals: ApprovalService;
  agent: LeonAgent;
  notifications: NotificationService;
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
  const approvals = new ApprovalService(db, bus);
  const agent = new LeonAgent(config, bus, chat, approvals, {
    sessions,
    tasks,
    prs,
    tmux,
    tracker: new ApprovalTracker(),
    approvals,
  });
  const notifications = new NotificationService(config, bus, (digest) =>
    agent.injectStatusDigest(digest),
  );

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
    approvals,
    agent,
    notifications,
    async start() {
      await monitor.start();
      prs.start();
      approvals.start();
      agent.start();
      notifications.start();
    },
    stop() {
      notifications.stop();
      agent.stop();
      approvals.stop();
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
export { ApprovalService, type Decision } from './services/approval-service.js';
export { ChatService } from './services/chat-service.js';
export { ApprovalTracker, describeMutation } from './agent/tools.js';
export { SessionService } from './services/session-service.js';
export { TaskService } from './services/task-service.js';
export { PrPoller } from './services/pr-service.js';
export { Tmux, parsePaneLine, type TmuxPane } from './tmux/tmux.js';
export { findClaudeDescendant, processSnapshot, isClaudeCommand } from './tmux/processes.js';
export { approvalFromRow, prFromRow, sessionFromRow, taskFromRow } from './db/rows.js';
