import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { notes, notesStatus, provider } from "../State.ts";
import { HelpButton } from "./HelpButton.tsx";

const saveDelay = 500;

/** Auto-growing notes field saved with the .benchforge archive. Renders as one
 *  muted line when empty and grows to fit its content as the user types. */
export function NotesPanel() {
  const dataProvider = provider.value!;
  const area = useRef<HTMLTextAreaElement>(null);
  const timer = useRef(0);
  const unsaved = useRef(false);

  useEffect(() => {
    dataProvider.fetchNotes().then(text => {
      // Ignore a late fetch if the user swapped archives or already typed.
      if (provider.value === dataProvider && !unsaved.current)
        notes.value = text;
    });
  }, [dataProvider]);

  useLayoutEffect(() => fitHeight(area.current), [notes.value]);

  function save(): void {
    if (!unsaved.current) return;
    unsaved.current = false;
    clearTimeout(timer.current);
    notesStatus.value = "saving";
    dataProvider
      .saveNotes(notes.value)
      // A newer edit may have landed mid-save; don't report "saved" over it.
      .then(() => {
        if (!unsaved.current) notesStatus.value = "saved";
      })
      .catch(err => {
        console.error("Notes save failed:", err);
        // Keep the note pending so a later blur/edit retries the save.
        unsaved.current = true;
        notesStatus.value = "error";
      });
  }

  function edit(e: Event): void {
    notes.value = (e.currentTarget as HTMLTextAreaElement).value;
    unsaved.current = true;
    notesStatus.value = "dirty";
    clearTimeout(timer.current);
    timer.current = window.setTimeout(save, saveDelay);
  }

  return (
    <div class="report-notes">
      <textarea
        ref={area}
        class="notes-input"
        rows={1}
        aria-label="Notes saved with the archive"
        placeholder={"Notes\u2026"}
        value={notes.value}
        onInput={edit}
        onBlur={save}
      />
      <div class="notes-meta">
        <NotesStatus file={dataProvider.config.notesFile} />
        <HelpButton topic="notes" />
      </div>
    </div>
  );
}

/** Muted tag showing whether the current note is persisted. Without a durable
 *  file, edits only live in this view, so anything typed reads "(unsaved)";
 *  the help popover explains how the Archive button keeps it. An untouched
 *  note loaded from a dropped archive is already persisted there, so it shows
 *  no tag. */
function NotesStatus({ file }: { file: string | null }) {
  const status = notesStatus.value;
  if (status === "error")
    return <span class="notes-status error">(save failed)</span>;
  if (!notes.value.trim()) return null;
  if (!file) {
    // Archive saveNotes only reaches the in-memory copy, so any edit
    // (dirty/saving/"saved") is unsaved until the archive is re-downloaded.
    if (status === "idle") return null;
    return <span class="notes-status">(unsaved)</span>;
  }
  const saved = status === "idle" || status === "saved";
  return <span class="notes-status">{saved ? "(saved)" : "(unsaved)"}</span>;
}

/** Size the textarea to its content (one row when empty). Scrolling stays
 *  hidden until content exceeds the CSS max-height; browser zoom rounding can
 *  leave a sub-pixel overflow that would otherwise paint a scrollbar. */
function fitHeight(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  const borders = el.offsetHeight - el.clientHeight; // 0 with the notes CSS
  el.style.height = `${el.scrollHeight + borders}px`;
  const capped = el.scrollHeight > el.clientHeight + 2;
  el.style.overflowY = capped ? "auto" : "hidden";
}
