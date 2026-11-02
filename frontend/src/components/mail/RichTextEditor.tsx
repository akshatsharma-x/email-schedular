'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton } from '@/components/ui/Button';

/**
 * Rich-text editor + formatting toolbar, matching the design's toolbar row.
 *
 * Built on `contenteditable` + `document.execCommand` rather than pulling in an
 * editor framework (TipTap/Slate/Quill are 50-150 KB and bring their own schema
 * and theming). `execCommand` is formally deprecated but is still the only
 * API implemented across every browser for this, and for the handful of inline
 * marks an email composer needs it is both sufficient and dependency-free.
 *
 * Two things that are easy to get wrong and are handled here:
 *
 *  1. **Don't re-render the editor from state.** Writing `innerHTML` on every
 *     keystroke destroys the DOM selection and the caret jumps to the start.
 *     The DOM is the source of truth while focused; `value` is only pushed in
 *     when it differs from what is already there (external resets).
 *  2. **Paste is stripped to plain text.** Pasting from a webpage or Word
 *     otherwise drags in fonts, colours and classes that look broken in a mail
 *     client and can carry markup we never intended to send.
 */

interface Props {
  value: string;
  onChange: (html: string, text: string) => void;
  placeholder?: string;
  minHeight?: string;
}

type Command =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'insertUnorderedList'
  | 'insertOrderedList'
  | 'justifyLeft'
  | 'justifyCenter'
  | 'justifyRight'
  | 'outdent'
  | 'indent'
  | 'removeFormat'
  | 'undo'
  | 'redo';

export function RichTextEditor({
  value,
  onChange,
  placeholder = 'Type Your Reply...',
  minHeight = '12rem',
}: Props): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Record<string, boolean>>({});

  // Push `value` in only when it genuinely differs -- see note (1) above.
  useEffect(() => {
    const el = ref.current;
    if (el && value !== el.innerHTML) el.innerHTML = value;
  }, [value]);

  const emit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // innerText (not textContent) keeps line breaks, which becomes the
    // text/plain MIME alternative.
    onChange(el.innerHTML, el.innerText);
  }, [onChange]);

  /** Reflects which marks apply at the caret, so the toolbar shows state. */
  const syncActive = useCallback(() => {
    if (typeof document.queryCommandState !== 'function') return;
    const read = (cmd: string): boolean => {
      try {
        return document.queryCommandState(cmd);
      } catch {
        return false;
      }
    };
    setActive({
      bold: read('bold'),
      italic: read('italic'),
      underline: read('underline'),
      insertUnorderedList: read('insertUnorderedList'),
      insertOrderedList: read('insertOrderedList'),
    });
  }, []);

  const exec = useCallback(
    (command: Command) => {
      // Focus first: execCommand applies to the current selection, and a
      // toolbar click moves focus to the button.
      ref.current?.focus();
      document.execCommand(command, false);
      emit();
      syncActive();
    },
    [emit, syncActive],
  );

  const onLink = useCallback(() => {
    ref.current?.focus();
    const url = window.prompt('Link URL');
    if (!url) return;
    // Only http(s) and mailto: a javascript: URL here would be stored and
    // re-rendered in the reading pane.
    if (!/^(https?:|mailto:)/i.test(url)) {
      window.alert('Links must start with http://, https:// or mailto:');
      return;
    }
    document.execCommand('createLink', false, url);
    emit();
  }, [emit]);

  useEffect(() => {
    document.addEventListener('selectionchange', syncActive);
    return () => document.removeEventListener('selectionchange', syncActive);
  }, [syncActive]);

  return (
    <div className="flex flex-col">
      <div
        ref={ref}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label="Email body"
        data-placeholder={placeholder}
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        onKeyUp={syncActive}
        onMouseUp={syncActive}
        onPaste={(e) => {
          // See note (2): paste as plain text.
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          document.execCommand('insertText', false, text);
        }}
        className="prose-mail w-full px-1 py-2 text-[13.5px] leading-relaxed text-ink focus:outline-none"
        style={{ minHeight }}
      />

      {/* Toolbar sits *below* the body, as in the design. */}
      <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-line bg-muted px-1.5 py-1">
        <Tool label="Undo" onClick={() => exec('undo')}>
          <path d="M9 7H5V3" />
          <path d="M5 7a7 7 0 1 1 2 11" />
        </Tool>
        <Tool label="Redo" onClick={() => exec('redo')}>
          <path d="M11 7h4V3" />
          <path d="M15 7a7 7 0 1 0-2 11" />
        </Tool>

        <Divider />

        <Tool label="Bold" active={active.bold} onClick={() => exec('bold')}>
          <path d="M6 3h5a3.5 3.5 0 0 1 0 7H6zM6 10h5.5a3.5 3.5 0 0 1 0 7H6z" />
        </Tool>
        <Tool label="Italic" active={active.italic} onClick={() => exec('italic')}>
          <path d="M8 3h6M6 17h6M11.5 3l-3 14" />
        </Tool>
        <Tool label="Underline" active={active.underline} onClick={() => exec('underline')}>
          <path d="M6 3v6a4 4 0 0 0 8 0V3M4.5 17h11" />
        </Tool>

        <Divider />

        <Tool label="Align left" onClick={() => exec('justifyLeft')}>
          <path d="M3.5 5h13M3.5 10h8M3.5 15h11" />
        </Tool>
        <Tool label="Align centre" onClick={() => exec('justifyCenter')}>
          <path d="M3.5 5h13M6 10h8M4.5 15h11" />
        </Tool>
        <Tool label="Align right" onClick={() => exec('justifyRight')}>
          <path d="M3.5 5h13M8.5 10h8M5.5 15h11" />
        </Tool>

        <Divider />

        <Tool
          label="Bulleted list"
          active={active.insertUnorderedList}
          onClick={() => exec('insertUnorderedList')}
        >
          <path d="M7 5h10M7 10h10M7 15h10M3.6 5h.1M3.6 10h.1M3.6 15h.1" />
        </Tool>
        <Tool
          label="Numbered list"
          active={active.insertOrderedList}
          onClick={() => exec('insertOrderedList')}
        >
          <path d="M8 5h9M8 10h9M8 15h9M3 4.2h1.2V7M3 9.2h1.4L3 12h1.6M3 14.2h1.5v1.1H3.2v1.2h1.3" />
        </Tool>
        <Tool label="Decrease indent" onClick={() => exec('outdent')}>
          <path d="M8 5h9M8 15h9M8 10h9M5 8l-2.5 2L5 12" />
        </Tool>
        <Tool label="Increase indent" onClick={() => exec('indent')}>
          <path d="M8 5h9M8 15h9M8 10h9M2.5 8L5 10l-2.5 2" />
        </Tool>

        <Divider />

        <Tool label="Insert link" onClick={onLink}>
          <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 1 0-4.2-4.2l-1 1" />
          <path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 1 0 4.2 4.2l1-1" />
        </Tool>
        <Tool label="Clear formatting" onClick={() => exec('removeFormat')}>
          <path d="M5 5h10M9 5l-2 10M12 11l4 5M16 11l-4 5" />
        </Tool>
      </div>
    </div>
  );
}

function Tool({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <IconButton
      label={label}
      active={active}
      // mousedown, not click: by click time the selection has already been lost
      // to the button, and the command would apply to nothing.
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      className="size-7"
    >
      <svg
        viewBox="0 0 20 20"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </IconButton>
  );
}

function Divider(): ReactNode {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-line-strong" aria-hidden="true" />;
}
