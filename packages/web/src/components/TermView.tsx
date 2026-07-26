import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { Session } from '@leon/shared';
import { useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import type { Ref } from 'react';
import { fetchCapture } from '../lib/api';
import { wsUrl } from '../lib/token';

/**
 * Client-side input gate. The socket is ALWAYS opened with mode=attach so
 * flipping between 'attach' and 'view' never reconnects — 'view' simply stops
 * forwarding keystrokes.
 */
export type TermInputMode = 'attach' | 'view';
export type TermConn = 'connecting' | 'open' | 'closed';

export interface TermViewHandle {
  focus(): void;
  blur(): void;
}

const TERM_THEME = {
  background: '#0b0c0e',
  foreground: '#d8dade',
  cursor: '#e2a33e',
  cursorAccent: '#0b0c0e',
  selectionBackground: '#2d3138',
  black: '#17191d',
  brightBlack: '#5b6066',
};

/**
 * One xterm wired to /ws/term/:id. Reconnects (cleanly closing the previous
 * socket first) whenever session.id changes; a generation counter guarantees a
 * stale capture/open can never resurrect a socket after the session switched.
 */
export function TermView({
  session,
  mode,
  onExit,
  onConnChange,
  autoFocus = false,
  ref,
}: {
  session: Session;
  mode: TermInputMode;
  /** fired when the pty stream closes underneath us */
  onExit?: () => void;
  onConnChange?: (conn: TermConn) => void;
  /** focus the terminal as soon as the stream opens (modal wants this; list view doesn't) */
  autoFocus?: boolean;
  ref?: Ref<TermViewHandle>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const generationRef = useRef(0);

  // Live mirrors so mode/callback changes never tear down the socket or xterm.
  const modeRef = useRef<TermInputMode>(mode);
  modeRef.current = mode;
  const autoFocusRef = useRef(autoFocus);
  autoFocusRef.current = autoFocus;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onConnRef = useRef(onConnChange);
  onConnRef.current = onConnChange;

  useImperativeHandle(
    ref,
    () => ({
      focus: () => termRef.current?.focus(),
      blur: () => termRef.current?.blur(),
    }),
    [],
  );

  const sendResize = useCallback(() => {
    const term = termRef.current;
    const ws = wsRef.current;
    if (term && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  }, []);

  /* xterm instance — lives as long as the component */
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

  /* websocket — one per session; prefill from capture-pane, then stream */
  useEffect(() => {
    const generation = ++generationRef.current;
    const live = () => generationRef.current === generation;
    let ws: WebSocket | null = null;

    onConnRef.current?.('connecting');
    termRef.current?.reset(); // clear leftovers from the previous session

    const open = () => {
      if (!live()) return;
      ws = new WebSocket(wsUrl(`/ws/term/${encodeURIComponent(session.id)}`, { mode: 'attach' }));
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (!live()) return;
        onConnRef.current?.('open');
        fitRef.current?.fit();
        sendResize();
        if (autoFocusRef.current && modeRef.current === 'attach') termRef.current?.focus();
      };
      ws.onmessage = (msg: MessageEvent) => {
        if (live() && msg.data instanceof ArrayBuffer) {
          termRef.current?.write(new Uint8Array(msg.data));
        }
      };
      ws.onclose = () => {
        if (!live()) return;
        onConnRef.current?.('closed');
        onExitRef.current?.();
      };
    };

    // One-shot capture-pane snapshot so the terminal isn't blank until new output.
    fetchCapture(session.id)
      .then(({ text }) => {
        if (live() && text) {
          termRef.current?.write(text.replaceAll('\n', '\r\n') + '\r\n');
        }
      })
      .catch(() => undefined)
      .finally(open);

    return () => {
      // Invalidate FIRST so onclose/late-capture are no-ops, then close cleanly —
      // never two sockets alive across a fast session switch.
      generationRef.current += 1;
      wsRef.current = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.close();
      }
    };
  }, [session.id, sendResize]);

  return <div ref={containerRef} className="h-full w-full" />;
}
