import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

/** Lazy-import a plot module and mount the resulting element into a div ref.
 *  Clears prior content, handles errors, and skips render if the ref detaches. */
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
        if (ref.current)
          ref.current.innerHTML = `<div class="loading">${err.message}</div>`;
      });
  }, deps);
  return ref;
}
