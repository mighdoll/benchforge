import { useEffect, useId, useLayoutEffect, useRef } from "preact/hooks";
import { openHelp, useEscapeClose } from "../State.ts";
import { type HelpTopic, helpContent } from "./HelpContent.tsx";

/** Small circled "?" that opens the help popover for one topic. One popover
 *  is open at a time (shared openHelp signal), keyed by button instance: the
 *  same topic appears on several cards, and only the clicked one should open. */
export function HelpButton({ topic }: { topic: HelpTopic }) {
  const id = useId();
  const open = openHelp.value === id;
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        type="button"
        class="help-button"
        aria-label={`help: ${helpContent[topic].title}`}
        aria-expanded={open}
        ref={btnRef}
        onClick={e => {
          // Several buttons sit inside larger click targets (e.g. sparkline
          // detail); don't trigger those.
          e.stopPropagation();
          openHelp.value = open ? null : id;
        }}
      >
        ?
      </button>
      {open && <HelpPopover topic={topic} anchor={btnRef} />}
    </>
  );
}

/** The popover card, anchored below its "?" button and clamped to the
 *  viewport (flipped above when it would overflow the bottom). Closes on an
 *  outside click, except on another "?" button, which its own toggle handles
 *  so switching topics stays one click. */
function HelpPopover({
  topic,
  anchor,
}: {
  topic: HelpTopic;
  anchor: preact.RefObject<HTMLButtonElement>;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const close = () => (openHelp.value = null);
  useEscapeClose(close);
  useOutsideClose(popRef, close);

  useLayoutEffect(() => {
    const pop = popRef.current;
    const btn = anchor.current;
    if (!pop || !btn) return;
    const rect = btn.getBoundingClientRect();
    const { width, height } = pop.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - width - 8),
    );
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8)
      top = Math.max(8, rect.top - height - 6);
    Object.assign(pop.style, {
      left: `${left}px`,
      top: `${top}px`,
      zIndex: "60",
    });
  }, [topic]);

  const { title, body } = helpContent[topic];
  return (
    <div class="help-popover" role="dialog" ref={popRef}>
      <span class="shift-close" onClick={close}>
        {"×"}
      </span>
      <h3>{title}</h3>
      {body}
    </div>
  );
}

/** Close the popover on a mousedown outside it. Clicks on any "?" button are
 *  left alone so that button's toggle can switch topics in a single click,
 *  rather than a full-screen overlay swallowing the first click. */
function useOutsideClose(
  ref: preact.RefObject<HTMLElement>,
  close: () => void,
): void {
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (ref.current?.contains(target) || target.closest(".help-button"))
        return;
      close();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
}
