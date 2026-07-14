import { useEffect, useRef, useState } from "react";

interface MultiSelectProps {
  placeholder: string; // shown when nothing is selected ("All sectors")
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  label?: (v: string) => string; // display transform (e.g. consLabel)
  noun?: string; // plural noun for the "N sectors" summary
  id?: string;
}

// A dropdown that lets you tick several options. Closed control matches the
// app's native <select>; open panel is a checkbox list.
export default function MultiSelect({
  placeholder, options, selected, onChange, label = (v) => v, noun = "selected", id,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  const summary =
    selected.length === 0 ? placeholder
      : selected.length === 1 ? label(selected[0])
        : `${selected.length} ${noun}`;

  return (
    <div className="ms" ref={rootRef}>
      <button
        type="button"
        id={id}
        className={`ms-btn ${selected.length ? "on" : "ph"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {summary}
      </button>
      {open && (
        <div className="ms-menu" role="listbox" aria-multiselectable="true">
          {options.map((o) => {
            const on = selected.includes(o);
            return (
              <button
                key={o}
                type="button"
                role="option"
                aria-selected={on}
                className="ms-opt"
                onClick={() => toggle(o)}
              >
                <span className={`ms-ck ${on ? "on" : ""}`} />
                {label(o)}
              </button>
            );
          })}
          {selected.length > 0 && (
            <button type="button" className="ms-clear" onClick={() => onChange([])}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
