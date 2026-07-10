# Calibration

Trusting a benchmark's numbers depends on two things you control: sizing each
run so its result is stable, and knowing your noise floor.

## Sizing your runs

There are two primary levers to control measurement: how long each batch runs,
and how many batches there are. `--duration` sets a time budget per batch
(`--iterations` fixes an exact iteration count instead); `--batches` sets the
batch count.

Use longer batches if repeated runs of your benchmark within the batch can
trigger full garbage collection cycles. Collection impacts are important to
measure, so you want the batch to be long enough to trigger full collection.
In fact, make the batch long enough for several full collections, not just one.
That helps the measurement converge on a more precise value.

If the program you're benchmarking doesn't trigger full collections when run
repeatedly, batch length only needs to be long enough for a stable sample count;
you tighten the margin by adding batches, not by lengthening them. Low-allocation
code on smaller data sets won't trigger full collection at all; cheap minor
collections (scavenges) will keep up. Also consider benchmarking with larger data
sets if appropriate.

You can look at the iterations tab in the UI to see the full collections per
batch if you benchmark with `--gc-stats`. Summary collection numbers are also in
the GC panel on the summary page.

Total time to benchmark is roughly `--duration` times `--batches`, and you can
trade one against the other: longer batches give steadier per-batch averages
when full collections are in play, more batches give a tighter confidence
interval. When per-batch averages swing because of full-collection placement,
lengthen `--duration` to get more collections per batch; otherwise prefer more
batches. To see whether each batch triggers full collections, step through the
batches on the time-per-iteration chart.

Aim for 40 batches or more for reliable comparison statistics.

For profiling (finding which functions spend the time or memory), note that the
run settings differ; see
[Profiling.md](Profiling.md#run-settings-for-profiling).

## Measuring the noise floor

Even with well-chosen run settings, comparing identical code against itself will
not report zero differences. Machine state drifts between measurements (CPU
frequency, caches, background load), and garbage collection is timing-sensitive:
collections fire at slightly different moments, and sometimes in different
numbers, from one run to the next. That residual movement is your setup's
**noise floor**. You set the equivalence margin to cover that floor, so real
differences can be distinguished from noise.

`--calibrate` runs a series of tests to measure the noise floor. Each test runs
your benchmark against an identical copy of itself. Because both sides are the
same code, the true difference is zero, so whatever spread the tests show is
pure measurement noise. From that spread, calibrate prints a suggested
`--equiv-margin`.

```bash
benchforge my-bench.ts --calibrate --batches 40 --duration 2
# ... per-run table ...
#   suggested --equiv-margin 0.5%
```

Copy the suggested value into your real comparisons, keeping the same
`--batches` and `--duration`:

```bash
benchforge my-bench.ts --baseline --batches 40 --duration 2 --equiv-margin 0.5
```

The margin is tied to those run settings. Confidence interval width scales
roughly as one over the square root of the batch count, so a margin measured at
one batch count is wrong for another. `--calibrate-runs` sets how many
self-comparisons to average (default 15). To keep the margin with the settings it
was measured at, bundle them as a preset (see
[Configuration.md](Configuration.md#presets)).

## The suggested margin

A single self-comparison is itself noisy, so `--calibrate` repeats the
comparison and measures the floor two ways:

- the **within-run** half-width: how wide the confidence interval is inside one
  comparison, which is what the bootstrap claims; and
- the **between-run** scatter: how much the measured difference moves from one
  self-comparison to the next.

The suggested margin is the larger of the two, rounded up. Taking the larger
makes the self-comparison read equivalent essentially every time, because the
margin then covers both the uncertainty the bootstrap sees within a single
comparison and the drift it only sees across comparisons.

## Getting a trustworthy margin

**Your error bars may be too optimistic.** If repeating the comparison moves the
result more than a single comparison's confidence interval predicted, the
machine is drifting between runs in a way one run cannot see. `--calibrate`
flags this. The suggested margin already accounts for it, since it uses the
larger of the two floors, but it is a sign to run more batches and to calibrate
under realistic conditions.

**Give each batch enough garbage collections, if it has any.** This applies only
when the workload triggers full collections. When batches average fewer than
about two (but more than none), the batch average depends on where its lone
collection lands, and that placement varies between runs in a way a single run
cannot see. `--calibrate` warns when full collections per batch are low, and
shows how they are distributed; if some batches see one more collection than
others, the per-batch average jumps by a whole collection. The fix is a longer
`--duration`, not more batches. A scavenge-dominated workload (zero full
collections) has no such artifact and draws no warning. Run with `--gc-stats` to
check.

**Calibrate the way you will compare.** Calibration measures the background load
present while it runs, so a quiet machine gives the tightest margin. If your
real comparisons run with an editor and browser open, calibrate that way too, so
the floor matches your everyday conditions.

**Bursty noise cannot be calibrated away.** A background task that fires during
some runs but not others is not a steady floor. Benchforge will reject only
obvious outlier batches as noise; lower-intensity noise mixes in with the data.
Run more batches when the machine is noisy, so any single burst counts for less
in the result, and expect benchforge to report wider (less certain) confidence
intervals.
