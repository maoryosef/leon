import { useEffect, useRef, useState } from 'react';
import { fetchScratchpad, putScratchpad } from '../lib/api';
import { relativeTime, useNow } from '../lib/time';
import { useBoardState } from '../lib/ws-store';

/**
 * The shared pad: freeform thoughts/todos the user and Leon converse about.
 * Debounced autosave; remote updates (Leon's approved edits, other tabs)
 * apply live unless the user has unsaved local typing — then a "pad changed
 * elsewhere" bar lets them choose.
 */
export function Scratchpad() {
  const { scratchpad } = useBoardState();
  const now = useNow();
  const [text, setText] = useState<string | null>(null); // null until loaded
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const lastSaved = useRef('');

  // initial load (REST) — WS snapshot doesn't carry the pad
  useEffect(() => {
    let cancelled = false;
    fetchScratchpad()
      .then((pad) => {
        if (cancelled || text !== null) return;
        setText(pad.content);
        lastSaved.current = pad.content;
        setSavedAt(pad.updatedAt);
      })
      .catch(() => setText(''));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // remote updates via WS
  useEffect(() => {
    if (!scratchpad || text === null) return;
    if (scratchpad.content === text) return;
    if (!dirty) {
      setText(scratchpad.content);
      lastSaved.current = scratchpad.content;
      setSavedAt(scratchpad.updatedAt);
    } else {
      setConflict(scratchpad.content);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scratchpad]);

  const save = (value: string) => {
    putScratchpad({ content: value })
      .then((pad) => {
        lastSaved.current = value;
        setDirty(false);
        setSavedAt(pad.updatedAt);
      })
      .catch(() => undefined);
  };

  const onChange = (value: string) => {
    setText(value);
    setDirty(value !== lastSaved.current);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => save(value), 800);
  };

  return (
    <div className="flex shrink-0 flex-col border-b border-line bg-panel">
      <div className="flex items-center gap-2 px-3 pt-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint select-none">
          Scratchpad
        </span>
        <span className="ml-auto font-mono text-[9.5px] text-faint">
          {dirty ? 'typing…' : savedAt ? `saved ${relativeTime(savedAt, now)}` : ''}
        </span>
      </div>
      {conflict !== null && (
        <div className="mx-3 mt-1 flex items-center gap-2 border border-accent/50 bg-accent/10 px-2 py-1 font-mono text-[10.5px] text-accent">
          pad changed elsewhere
          <button
            type="button"
            className="ml-auto underline"
            onClick={() => {
              setText(conflict);
              lastSaved.current = conflict;
              setDirty(false);
              setConflict(null);
            }}
          >
            load theirs
          </button>
          <button
            type="button"
            className="underline"
            onClick={() => {
              setConflict(null);
              if (text !== null) save(text);
            }}
          >
            keep mine
          </button>
        </div>
      )}
      <textarea
        value={text ?? ''}
        placeholder={text === null ? 'loading…' : '# thoughts / todos — Leon reads this too'}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        className="h-40 w-full resize-y bg-transparent px-3 py-2 font-mono text-[12.5px] leading-relaxed text-txt placeholder:text-faint outline-none"
      />
    </div>
  );
}
