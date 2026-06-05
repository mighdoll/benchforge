# Statistical Methods in Benchforge

## The Problem: Noisy Measurements

Benchmark data has two kinds of variability that look similar but need opposite
treatment:

**Intermittent signals**: GC pauses, JIT tier transitions, memory pressure.
These are real costs your code pays. A function that allocates more triggers
more GC, and that overhead is part of its true cost. These should be captured.

**Intermittent noise**: other applications waking up, OS scheduling jitter,
thermal throttling, background updates. These have nothing to do with the code
under test. These should be rejected.

No single statistic handles both. Averaging captures GC but also captures laptop
noise. Median filters noise but also hides GC. Benchforge addresses this at two
levels: batches reject environmental noise from comparisons, while multiple
statistics and visualizations reveal the full picture of a single benchmark.

## Batched Execution

Batches are independent runs of baseline and current, interleaved across time.
With `--batches 10`, benchforge runs 10 rounds, alternating which goes first:

```
batch 0: baseline, current     (dropped -- warmup)
batch 1: current, baseline
batch 2: baseline, current
batch 3: current, baseline
...
```

**Alternating order** cancels systematic bias. Without it, the second benchmark
always benefits from warmer CPU caches and memory state. Reversing the order on
odd batches distributes this advantage evenly.

**Warmup batch**: Batch 0 is dropped by default. The first batch pays one-time
OS costs (page cache population, CPU cache priming, memory allocator warmup)
that don't reflect steady-state performance. Use `--warmup-batch` to include it.

Each batch runs for the full `--duration` independently. Total measurement time
is duration x batches.

## Value Estimates

When looking at a single benchmark (no baseline comparison), multiple statistics
together tell the full story.

**Median (p50)** is the typical iteration cost. It's robust to GC spikes and
noise. Median tells you how fast your algorithm runs *between* disruptions. This
is the "clean" speed of your code.

**Mean** is the amortized cost including everything including GC pauses, JIT
compilation time, etc.. It reflects the actual wall-clock throughput: total time
divided by iterations.

**When median and mean diverge**, that's informative. A large gap means GC or
other intermittent costs are significant. If a code change makes mean worse
while median stays flat, you likely increased allocation pressure, a real
regression that median alone would hide.

**Tail percentiles** (p90, p99) show worst-case iteration behavior. High p99
relative to median indicates occasional expensive iterations, often from GC
pauses or JIT recompilation.

Point estimates are computed from pooled samples across batches, excluding any
batches rejected by Tukey trimming. Confidence intervals come from block
bootstrap (see below).

## Selecting Statistics

The default report shows `mean`, `p50`, and `p99`. Use `--stats` to pick a
different set of timing columns. Works identically in Node and browser modes.

```bash
benchforge my-bench.ts --stats mean,p70,p95,p99,max
benchforge --url http://localhost:5173 --stats p50,p95,p999
```

Valid tokens:

| Token | Meaning |
|-------|---------|
| `mean` / `avg` | arithmetic mean |
| `median` / `p50` | 50th percentile |
| `min`, `max` | smallest / largest sample |
| `pNN` (2 digits) | NN-th percentile (e.g. `p70`, `p95`, `p99`) |
| `pN...` (3+ digits) | sub-percentile precision, must start with `9` (e.g. `p999` = 99.9%, `p9999` = 99.99%) |

Each column gets a bootstrap confidence interval against the baseline (when one
is present), computed in the same domain as the column.

## Tukey Trimming

Individual samples within a batch are correlated: they share the same thermal
state, memory layout, and background load. Batches are the unit of independence.

By default, outlier batches are removed. The batch means are sorted and divided
into quartiles, Q1 (25th percentile) and Q3 (75th percentile). The
interquartile range (IQR) is Q3 - Q1. Batches whose mean exceeds Q3 + 3x IQR are
removed. Only high outliers are trimmed.

## Block Bootstrap

Each of 10,000 bootstrap iterations picks a random set of batches from the
available batches (the same batch may be picked more than once), then reduces
that set to a single value, the iteration's estimate of the statistic. The 2.5th
and 97.5th percentiles of those 10,000 values form the 95% confidence interval.

The random pick is always a whole batch, never an individual sample within a
batch. Bootstrap relies on its observations being independent of each other and
drawn from the same distribution. Samples within a batch share thermal state,
memory layout, and scheduler context, so they aren't independent; batches are.
Picking whole batches preserves the independence bootstrap depends on.

This applies to both single-benchmark CIs and baseline comparisons. For
comparisons, each iteration picks an independent random set of batches for the
baseline and another for the current run, then computes the percentage
difference between the two iteration values.

Traditional bootstrap picks individual samples at random; block bootstrap picks
whole batches instead. When a little noise moves the benchmark results
differently in different batches, we want to report that by widening the
confidence interval appropriately.

Imagine a background OS task slows several iterations in the batch by 10%. That
might not be enough to trigger Tukey trimming, but it would increase our batch
level variance. We want to widen our confidence interval to indicate the
uncertainty.

If we mixed results across all batches, we'd be overconfident, imagining that
our iterations are more independent than they actually are. We might erroneously
report to the user that their code is slower when in fact it was just noise.

### What each iteration computes

How each iteration reduces its selected batches to a single value depends on
whether the statistic is linear in the samples:

- **Mean**: each iteration takes `mean(per-batch mean)` over the selected
  batches. With equal-size batches this equals `mean(pool)` exactly, so the CI
  it builds is a valid uncertainty estimate for `mean(pool)`.

- **Percentiles (p50, p90, p99, ...)**: `p50(pool)` is our best estimate of the
  underlying p50, and we want the CI to bound how much that estimate would shift
  if we'd drawn a different set of batches. So each iteration pools its selected
  batches' samples and recomputes the percentile on that pool, producing a fresh
  draw of the same quantity we're estimating. The selection step is unchanged
  from the mean case; we still pick whole batches at random and the same batch
  may be picked more than once, with the samples inside a chosen batch traveling
  together.

`min` and `max` aren't bootstrapped; the displayed value is the single observed
extreme.

## Batch Duration

Batch count controls CI width, but `--duration` and `--iterations` control what
each batch actually measures. `--duration` sets a time budget per batch;
`--iterations` sets a fixed iteration count instead.

Each batch starts with a fresh heap, so allocation builds from zero. If the
batch is too short, the heap may never fill enough to trigger a full (major) GC,
the batch mean then reflects only young-generation scavenges, missing the
amortized cost of major collections entirely.

With medium-length batches, a full collection fires but exactly when it fires
varies from batch to batch. That timing jitter has a larger effect on the
per-batch mean when there's only one full GC in the batch. With longer batches,
multiple full collections happen and the per-batch mean stabilizes.

This matters most when you care about mean (amortized throughput). If you're
only tracking median, GC timing is less significant since median is robust to
individual pauses.

**Guidance:** if per-batch means have high variance, try increasing `--duration`
(or `--iterations`) before adding more batches. Total measurement time is
roughly `duration x batches`, and you can trade between them. Longer batches
give more stable per-batch means, while more batches give tighter CIs. Start
with `--duration 2` or higher for benchmarks with significant allocation.

## Comparison Statistics

When comparing against a baseline, the question changes from "how fast is this?"
to "did it get faster or slower, and by how much?"

### Equivalence Margin

A confidence interval answers "what range of differences is plausible?" but
doesn't directly answer "is this change meaningful?" The equivalence margin
bridges that gap.

Traditional CI testing asks: does the CI exclude zero? But with enough batches,
even trivial noise (ASLR, scheduler jitter) can push the CI away from zero. The
result gets stuck at "slower" or "faster" when comparing identical code. The
test detects real differences but can never confirm equivalence.

The equivalence margin (`--equiv-margin`, default 2%) defines the smallest
difference that matters. With a margin set, the only thresholds are `-margin`
and `+margin`; each verdict is a whole-CI test on where the entire interval
sits relative to that band:

```
         -margin       0       +margin
            |          |          |
    [---]   |          |          |         ==> FASTER  (entire CI beyond margin)
            |          |          |  [---]  ==> SLOWER  (entire CI beyond margin)
            |          | [-----]  |         ==> EQUIVALENT (entire CI within margin)
            |          |     [--------]     ==> INCONCLUSIVE (straddles the margin)
```

**Equivalent** means the entire CI fits within the margin. The difference is
provably smaller than what matters, whether or not it's statistically
significant: a CI that excludes zero but stays inside the band (above) is
equivalent, because the band, not zero, is the bar that matters.

**Faster / Slower** means the entire CI lies beyond the margin. A real,
meaningful change, confidently past the noise floor.

**Inconclusive** means the CI straddles a margin edge, so the result is neither
proven-equivalent nor proven-different. More batches would narrow it. (Gating on
the whole CI rather than the point estimate is what makes this stable: with
margin 0 the test reduces to the plain CI-excludes-zero check, and adding a
small margin doesn't suddenly flip verdicts on point-estimate noise.)

#### Calibrating the Margin

The right margin varies with the machine and the code. The margin should cover
everything that makes a measurement move between runs *without* the code
changing. Two sources dominate: other activity on the machine competing for CPU
and memory (other apps, background daemons, indexing, plus thermal and
frequency shifts), and the code's own GC, whose collection timing varies run to
run and wobbles the measured speed.

`--calibrate` measures this directly. It runs the current build against an
identical copy of itself, repeated many times, then prints a suggested
`--equiv-margin`:

```bash
benchforge my-bench.ts --calibrate --batches 50 --duration 2
# ... per-run table ...
#   suggested --equiv-margin 0.5%

# Copy the suggested value into real comparison runs:
benchforge my-bench.ts --baseline --batches 50 --duration 2 --equiv-margin 0.5
```

A single self-comparison CI is itself noisy, so calibrate repeats the run and
reports two views of the floor: the **within-run CI half-width** (what the
bootstrap claims) and the **between-run scatter** of the point estimates (what
actually happens on repeat). The suggested margin is the larger of the two, so
the self-comparison reads "equivalent" essentially every time. If the scatter
exceeds the within-run CI, calibrate warns that the displayed CIs are
overconfident: run-to-run drift the bootstrap can't see from inside one run.

For the suggested margin to apply to your real comparisons:

- **Use the same `--batches` and `--duration`** you'll use for comparisons. CI
  width scales roughly with `1/sqrt(batches)`, so a margin measured at one batch
  count is wrong for another.
- **For GC-sensitive code, give each batch a few full GCs.** Set `--duration`
  long enough that at least ~2 major collections happen per batch. With only
  one, the batch mean depends on where that collection lands, and its timing
  varies between runs in a way the within-run CI can't see, a common cause of
  the overconfidence warning. Run with `--gc-stats` to check; calibrate warns
  when full GCs per batch is too low. Longer batches fix this; more batches
  don't.

##### Calibrate the way you'll compare

Calibration measures the background load present while it runs, so a quiet
machine gives the tightest margin (quit other apps, pause background sync and
updates, avoid thermal throttling). But if you do routine checks with your
editor and browser open, calibrate that way too, so the margin reflects your
steady background load rather than an idle machine.

Bursty noise is different: a surge may or may not fire during any given
calibration run, so the margin can't reliably account for it. Benchforge drops
slow-outlier batches, so a clear surge is discarded outright. A sub-threshold
surge is diluted across the other batches, usually widening the interval to
"uncertain" rather than flipping a verdict. But with a narrow margin, a
sub-threshold surge can still tip a result to a false better/worse. Two things
guard against a false verdict: calibrate the steady floor under representative
conditions, and run more batches when the machine is noisy (more batches both
dilute each surge and give the outlier filter more to work with).

### Batch Count

Benchforge warns when a comparison has fewer than 20 batches and disables the
direction indicator. For reliable comparisons, use 40+ batches. More batches
narrow the confidence interval and shrink how much any single environmental
surge can move the result; the tradeoff is increased time for tests.

## Reading the Results

Results are displayed as: `+2.5% [-1.2%, +6.1%]`

- The first number is the observed percentage difference (positive = slower)
- The bracketed range is the 95% confidence interval
- Color indicates direction: green for faster, red for slower, gray for
  uncertain

The UI display shows even more information.

**"Uncertain" or "Inconclusive"** means the CI is too wide to decide. The fix is
more batches: each additional batch is another independent observation that
narrows the interval. Aim for 40+ batches for reliable results.

**Median and mean tell different stories?** Check whether GC overhead changed.
If mean regressed but median didn't, allocation patterns likely shifted. Both
numbers matter: median for algorithmic cost, mean for real-world throughput.

## Reading the Change-by-Percentile Chart

The HTML viewer's "change by percentile" chart (a shift function) shows one
violin per statistic (mean, then p1, p5, p10, ... p99). It answers "did the
change land evenly across the distribution, or only in part of it?" The leftmost
mean violin matches the headline number; the percentile violins show the same
comparison at each point of the distribution.

**Each violin is a bootstrap distribution of the *difference*, not of your raw
timings.** Every block-bootstrap resample (whole batches, see above) recomputes
the percent change at that percentile; the violin is the spread of those
resampled changes. So a violin describes *how confidently we know the change
here*, not how the underlying samples are spread.

Two dimensions encode the same uncertainty from different angles:

- **Vertical extent** is the range of percent-change values the resamples
  produced. A taller violin means the estimate moved more when different batches
  were drawn, which means it is less certain.
- **Horizontal width** is density: how many resamples landed at that change
  value (mirrored for shape, so left and right carry no meaning). A fatter violin
  means more resamples piled there. Width is shared across all violins, so a
  fatter one genuinely means more concentrated, not just rescaled.

Because each violin holds the same number of resamples, the two trade off: a
**short, fat** violin is well-pinned (confident), a **tall, thin** one is
uncertain. The hollow circle is the point estimate; the zero line and the
hatched +/- equivalence band are reference zones.

**Color is a per-percentile reliability flag, not part of the shape.** A
percentile is colored (blue/green/red by direction) only when enough samples lie
beyond it across enough distinct batches to pin it down; otherwise it is greyed.
Greying gates *whether you can trust where the violin sits* (its position and
direction), per percentile. It does not change the violin's shape, and it is not
a verdict on the whole run: a single run routinely has reliable middle
percentiles and greyed extreme tails (the 1% tail rarely spans enough batches).

What to take from it:

- **Trust the position of colored violins, not greyed ones.** A greyed violin's
  point estimate could swing on a different draw; read it only as "not enough
  coverage here," not as evidence about the data.
- **A lone colored violin in a field of grey is usually noise**, not a real
  per-percentile effect. With nine percentiles shown at once, expect one to roll
  the dice and color spuriously fairly often; nothing makes that percentile
  special.
- **Color cannot tell you whether a shape reflects your code or your test
  setup.** A reliably-colored violin faithfully measures whatever your sampling
  produced, which may be a measurement artifact. Short batches that fire a GC in
  only some batches, for example, can split the slow tail into two regimes and
  make a mid-tail percentile look unusually spread, even while it passes the
  reliability gate. Distinguishing data structure from sampling artifact needs a
  second run that changes one knob at a time. More **batches** narrows every
  violin (roughly as one over the square root of the batch count) and improves
  tail coverage, but it preserves any real structure. More **duration** changes
  what each batch measures, for instance by giving every batch enough full GCs to
  behave alike. If a feature survives more batches but dissolves with more
  duration, it was a batch-length artifact, not your code.
