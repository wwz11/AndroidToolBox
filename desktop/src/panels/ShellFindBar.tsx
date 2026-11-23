import type { RefObject } from "react";
import type { ShellSearchHit } from "./ShellTerminal";

type Props = {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  caseSensitive: boolean;
  hit: ShellSearchHit | null;
  onQueryChange: (q: string) => void;
  onStep: (backwards: boolean) => void;
  onClear: () => void;
  onToggleCase: () => void;
};

export default function ShellFindBar({
  inputRef,
  query,
  caseSensitive,
  hit,
  onQueryChange,
  onStep,
  onClear,
  onToggleCase,
}: Props) {
  return (
    <div className="shell-find">
      <input
        ref={inputRef}
        className="field shell-find-input"
        value={query}
        placeholder="查找"
        spellCheck={false}
        aria-label="查找"
        title="查找 (Ctrl+F)"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            onStep(e.shiftKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClear();
          }
        }}
      />
      <span className="shell-find-count">
        {query.trim()
          ? hit?.count
            ? `${hit.index + 1}/${hit.count}`
            : "0/0"
          : ""}
      </span>
      <button
        type="button"
        className="shell-find-step"
        disabled={!query.trim()}
        title="上一个 (Shift+Enter)"
        onClick={() => onStep(true)}
      >
        ↑
      </button>
      <button
        type="button"
        className="shell-find-step"
        disabled={!query.trim()}
        title="下一个 (Enter)"
        onClick={() => onStep(false)}
      >
        ↓
      </button>
      <button
        type="button"
        className={`shell-find-aa${caseSensitive ? " on" : ""}`}
        title="区分大小写"
        aria-pressed={caseSensitive}
        onClick={onToggleCase}
      >
        Aa
      </button>
    </div>
  );
}
