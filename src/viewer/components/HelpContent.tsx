import type { ComponentChildren } from "preact";
import type { CIDirection } from "../../stats/Bootstrap.ts";
import { directionColors } from "../plots/PlotTypes.ts";

/** Topic ids for the "?" help popovers, one per explained UI element. */
export type HelpTopic =
  | "verdict"
  | "verdictChart"
  | "noiseRejection"
  | "metricValues"
  | "shiftChart"
  | "equivalenceMargin"
  | "timeSeries"
  | "histogram";

// TODO: help for the GC panel (--gc-stats): alloc/iter, collected, scav, full,
// promo%, pause/iter -- read as GC cost behind the timing.

const docBase = "https://github.com/mighdoll/benchforge/blob/main/";

/** Link to a standalone doc on GitHub, opened in a new tab. */
function DocLink({ doc, children }: { doc: string; children: ComponentChildren }) {
  return (
    <a href={docBase + doc} target="_blank" rel="noopener">
      {children}
    </a>
  );
}

/** Swatch legend for violin colors: light fill with a colored outline, echoing
 *  how the violins are actually drawn (fill at low opacity + solid stroke). */
function ViolinLegend() {
  const entries: [CIDirection, string][] = [
    ["faster", "faster"],
    ["slower", "slower"],
    ["equivalent", "equivalent (within the noise margin)"],
    ["uncertain", "inconclusive"],
  ];
  return (
    <ul class="help-legend">
      {entries.map(([dir, label]) => {
        const { stroke } = directionColors[dir];
        const swatch = {
          border: `1.5px solid ${stroke}`,
          background: `color-mix(in srgb, ${stroke} 25%, transparent)`,
        };
        return (
          <li key={dir}>
            <i style={swatch} /> {label}
          </li>
        );
      })}
    </ul>
  );
}

/** Popover text per help topic. Written for first-time readers: plain words,
 *  no unexplained stats jargon, generic (no specific benchmarks or numbers). */
export const helpContent: Record<
  HelpTopic,
  { title: string; body: ComponentChildren }
> = {
  verdict: {
    title: "Faster, slower, or equivalent?",
    body: (
      <>
        <p>
          The colored pill sums up how this case compares against the
          baseline:
        </p>
        <ul>
          <li>
            <b>Faster / Slower</b> -- the change is clearly bigger than the
            noise.
          </li>
          <li>
            <b>Equivalent</b> -- any change is too small to tell apart from
            noise.
          </li>
          <li>
            <b>Inconclusive</b> -- the measurements can't say yet; collecting
            more batches usually resolves it.
          </li>
        </ul>
        <p>
          For a measure where higher is better (such as throughput), "Faster"
          still means better.
        </p>
      </>
    ),
  },

  verdictChart: {
    title: "Reading this chart",
    body: (
      <>
        <p>
          The percentage is the measured change from the baseline; for time,
          negative means faster. The chart shows how precisely it was
          measured:
        </p>
        <ul>
          <li>
            The <b>curve</b> spans the plausible values for the change,
            peaked at the most likely ones.
          </li>
          <li>
            The <b>colored box</b> covers the middle 95% of that range.
          </li>
          <li>
            The <b>black line</b> marks zero: no change from the baseline.
          </li>
          <li>
            The <b>yellow band</b> is the noise margin: changes inside it are
            too small to tell apart from measurement noise.
          </li>
        </ul>
        <p>Click the chart for details.</p>
      </>
    ),
  },

  noiseRejection: {
    title: "Noise rejection",
    body: (
      <>
        <p>
          Drops batches that look like environmental noise (other apps, OS
          scheduling, thermal throttling) so they don't distort the results.
          A batch is dropped when it runs slower than the others by more than
          three times their typical variation.
        </p>
      </>
    ),
  },

  metricValues: {
    title: "Measured values",
    body: (
      <>
        <p>
          One row for each version of the code that was benchmarked. The
          small curve shows the plausible range for the true value: a narrow
          spike is a precise measurement, a wide curve a rough one.
        </p>
        <p>Click a row for details.</p>
      </>
    ),
  },

  shiftChart: {
    title: "Change by percentile",
    body: (
      <>
        <p>
          Shows how the change from the baseline varies across iterations,
          from the fastest to the slowest. The value that drives the
          faster/slower call is in bold (usually the mean).
        </p>
        <p>
          Each violin shows the change at one percentile, with a mark at the
          best estimate. Its height is uncertainty: short and wide means the
          change is well measured; tall and thin means it is uncertain. Click
          any violin for more detail.
        </p>
        <p>Colors show the result at each percentile:</p>
        <ViolinLegend />
        <p>
          Gray is common on short runs: an extreme percentile like p99 needs
          a lot of data out in the tail. The axis is scaled to the
          well-measured percentiles, so an extreme violin can run off the
          chart: a gray dashed one was too noisy to pin down at all, while a
          colored one shows its change below its label.
        </p>
        <p>
          Learn more: <DocLink doc="Statistics.md">Statistics.md</DocLink>
        </p>
      </>
    ),
  },

  equivalenceMargin: {
    title: "The shaded band",
    body: (
      <>
        <p>
          The zero line marks no change from the baseline. The shaded band
          around it is the equivalence margin: changes so small they can't be
          told apart from measurement noise on this machine.
        </p>
        <p>
          A violin inside the band is effectively unchanged at that
          percentile; one fully clear of the band is a real change; one
          straddling an edge is inconclusive.
        </p>
        <p>
          Learn more: <DocLink doc="Calibration.md">Calibration.md</DocLink>{" "}
          covers measuring the noise floor and setting the margin.
        </p>
      </>
    ),
  },

  timeSeries: {
    title: "Time per iteration",
    body: (
      <>
        <p>
          Execution time for each iteration, in the order collected. Use it to
          spot the warmup ramp, the GC sawtooth, a disturbed batch, or drift
          over the run. The batch stepper views all batches at once or one at
          a time.
        </p>
        <p>Overlays correlate timing with engine activity:</p>
        <ul>
          <li>
            <b>heap</b> -- heap size, showing the allocation sawtooth between
            collections.
          </li>
          <li>
            <b>full GC</b> -- where major (full) garbage collections occurred.
          </li>
          <li>
            <b>rejected</b> -- samples in batches removed by noise rejection.
          </li>
        </ul>
      </>
    ),
  },

  histogram: {
    title: "Time distribution",
    body: (
      <p>
        How often each execution time occurred. Reveals bimodality (a fast
        mode and a slow GC mode as two humps) and long tails that a single
        average hides.
      </p>
    ),
  },
};
