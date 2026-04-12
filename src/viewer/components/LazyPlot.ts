import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

/**
 * Lazy-import a plot module and mount the resulting element into a div ref.
 * Defers the ~hundreds-of-KB `@observablehq/plot` + `d3` bundle until the
 * Samples tab is actually opened, keeping the initial viewer load small.
 */
export function useLazyPlot(
  render: () => Promise<Element | null | undefined>,
  deps: unknown[],
  errorLabel?: string,
): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    render()
      .then(el => {
        if (!ref.current || !el) return;
        ref.current.innerHTML = "";
        ref.current.appendChild(el);
      })
      .catch(err => {
        console.error(`${errorLabel ?? "Plot"} failed:`, err);
        if (ref.current) {
          const div = document.createElement("div");
          div.className = "loading";
          div.textContent = String(err.message ?? err);
          ref.current.replaceChildren(div);
        }
      });
  }, deps);
  return ref;
}
