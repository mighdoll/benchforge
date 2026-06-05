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

/**
 * Lazy-mount a plot that fills its container, re-rendering at the container's
 * current width via a ResizeObserver. `render` receives the measured content
 * width in px. For plots whose card width is dynamic (e.g. the shift fan).
 */
export function useResponsivePlot(
  render: (width: number) => Promise<Element | null | undefined>,
  deps: unknown[],
  errorLabel?: string,
): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  const lastWidth = useRef(0);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    let cancelled = false;
    function draw(width: number) {
      if (width <= 0) return;
      render(width)
        .then(el => {
          if (cancelled || !ref.current || !el) return;
          ref.current.replaceChildren(el);
        })
        .catch(err => {
          console.error(`${errorLabel ?? "Plot"} failed:`, err);
          if (!cancelled && ref.current) {
            const div = document.createElement("div");
            div.className = "loading";
            div.textContent = String(err.message ?? err);
            ref.current.replaceChildren(div);
          }
        });
    }
    const observer = new ResizeObserver(entries => {
      const width = Math.round(entries[0].contentRect.width);
      if (width === lastWidth.current) return;
      lastWidth.current = width;
      draw(width);
    });
    observer.observe(host);
    return () => { cancelled = true; observer.disconnect(); };
  }, deps);
  return ref;
}
