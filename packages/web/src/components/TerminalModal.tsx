import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { Session } from '@leon/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCapture } from '../lib/api';
import { sessionTitle, tmuxTarget } from '../lib/format';
import { wsUrl } from '../lib/token';
import { StatusBadge } from './StatusBadge';

type TermMode = 'peek' | 'attach';
type TermConn = 'connecting' | 'open' | 'closed';

const TERM_THEME = {
  background: '#0b0c0e',
  foreground: '#d8dade',
  cursor: '#e2a33e',
  cursorAccent: '#0b0c0e',
  selectionBackground: '#2d3138',
  black: '#17191d',
  brightBlack: '#5b6066',
};

export function TerminalModal({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<TermMode>('peek');
  const [conn, setConn] = useState<TermConn>('connecting');
  const [copied, setCopied] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const modeRef = useRef<TermMode>(mode);
  const prefilledRef = useRef(false);
  modeRef.current = mode;

  const sendResize = useCallback(() => {
    const term = termRef.current;
    const ws = wsRef.current;
    if (term && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  }, []);

  /* xterm instance — lives for the whole modal */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily:
        'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      scrollback: 5_000,
      theme: TERM_THEME,
      cursorBlink: false,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    term.onData((data) => {
      const ws = wsRef.current;
      if (modeRef.current === 'attach' && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    termRef.current = term;
    fitRef.current = fit;

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      sendResize();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sendResize]);

  /* websocket — reopened when the mode flips */
  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    setConn('connecting');

    const open = () => {
      if (cancelled) return;
      ws = new WebSocket(wsUrl(`/ws/term/${encodeURIComponent(session.id)}`, { mode }));
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setConn('open');
        fitRef.current?.fit();
        sendResize();
        if (modeRef.current === 'attach') termRef.current?.focus();
      };
      ws.onmessage = (msg: MessageEvent) => {
        if (msg.data instanceof ArrayBuffer) {
          termRef.current?.write(new Uint8Array(msg.data));
        }
      };
      ws.onclose = () => {
        if (!cancelled) setConn('closed');
      };
    };

    if (!prefilledRef.current) {
      // One-shot capture-pane snapshot so the terminal isn't blank until new output.
      fetchCapture(session.id)
        .then(({ text }) => {
          if (!cancelled && text && !prefilledRef.current) {
            prefilledRef.current = true;
            termRef.current?.write(text.replaceAll('\n', '\r\n') + '\r\n');
          }
        })
        .catch(() => undefined)
        .finally(open);
    } else {
      open();
    }

    return () => {
      cancelled = true;
      wsRef.current = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.close();
      }
    };
  }, [session.id, mode, sendResize]);

  /* Esc closes — only while peeking; attached keystrokes belong to the pane */
  useEffect(() => {
    if (mode !== 'peek') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, onClose]);

  const copyAttachCmd = () => {
    void navigator.clipboard
      .writeText(`tmux attach -t '${session.tmuxSessionName}'`)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      });
  };

  const banner =
    mode === 'peek'
      ? { text: 'peeking — read-only', className: 'border-line-strong bg-raise text-dim' }
      : {
          text: 'attached — keystrokes are live',
          className: 'border-danger bg-danger/15 text-danger',
        };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-[80vh] w-[85vw] flex-col border border-line-strong bg-bg shadow-[0_8px_40px_rgba(0,0,0,0.8)]">
        <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-3 py-2">
          <span className="truncate text-[12.5px] font-medium text-txt">
            {sessionTitle(session)}
          </span>
          <span className="font-mono text-[10.5px] text-faint">{tmuxTarget(session)}</span>
          <StatusBadge status={session.status} source={session.statusSource} />
          {conn !== 'open' && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
              {conn === 'connecting' ? 'connecting…' : 'stream closed'}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={copyAttachCmd}
              className="border border-line-strong bg-raise px-2 py-1 font-mono text-[10.5px] text-dim hover:border-dim hover:text-txt"
            >
              {copied ? 'copied' : 'copy attach cmd'}
            </button>
            {mode === 'peek' ? (
              <button
                type="button"
                onClick={() => setMode('attach')}
                className="border border-accent/60 bg-accent/10 px-2 py-1 font-mono text-[10.5px] font-semibold text-accent hover:bg-accent/20"
              >
                Attach
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setMode('peek')}
                className="border border-line-strong bg-raise px-2 py-1 font-mono text-[10.5px] text-dim hover:border-dim hover:text-txt"
              >
                Detach
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close terminal"
              className="border border-line-strong bg-raise px-2 py-1 font-mono text-[10.5px] text-dim hover:border-dim hover:text-txt"
            >
              ✕
            </button>
          </div>
        </header>

        <div
          className={`shrink-0 border-b px-3 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em] ${banner.className}`}
        >
          {banner.text}
        </div>

        <div ref={containerRef} className="min-h-0 flex-1 bg-bg p-2" />
      </div>
    </div>
  );
}
