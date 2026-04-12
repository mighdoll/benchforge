# Statistical Methods in Benchforge

## The Problem: Noisy Measurements

Benchmark data has two kinds of variability that look similar but need opposite
treatment:

**Intermittent signals** -- GC pauses, JIT tier transitions, memory pressure.
These are real costs your code pays. A function that allocates more triggers
more GC, and that overhead is part of its true cost. These should be captured.

**Intermittent noise** -- other applications waking up, OS scheduling jitter,
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
while median stays flat, you likely increased allocation pressure -- a real
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

Each column gets a bootstrap confidence interval against the baseline (when
one is present), computed in the same domain as the column.

## Tukey Trimming

Individual samples within a batch are correlated -- they share the same thermal
state, memory layout, and background load. Batches are the unit of independence.

By default, outlier batches are removed. The batch means are sorted and divided
into quartiles -- Q1 (25th percentile) and Q3 (75th percentile). The
interquartile range (IQR) is Q3 - Q1. Batches whose mean exceeds Q3 + 3x IQR are
removed. Only high outliers are trimmed.

## Block Bootstrap

The target statistic (mean, median, p90, etc.) is computed per batch. Then for
each of 10,000 bootstrap iterations, the batch statistics are resampled with
replacement and averaged. The 2.5th and 97.5th percentiles of the 10,000
averages form the 95% confidence interval.

This applies to both single-benchmark CIs and baseline comparisons. For
comparisons, each iteration resamples both sides independently and computes the
percentage difference between their averages.

Unlike traditional bootstrap which resamples individual samples, block bootstrap
resamples at the batch level. When a little noise moves the benchmark results
differently in different batches, we want to report that by widening the
confidence interval appropriately.

Imagine a background OS task slows several iterations in the batch by 10%. That
might not be enough to trigger Tukey trimming, but it would increase our batch
level variance. We want to widen our confidence interval to indicate the
uncertainty.

If we mixed results across all batches, we'd be overconfident, imagining that
our iterations are more independent than they actually are. We might erroneously
report to the user that their code is slower when in fact it was just noise.

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
difference that matters. The CI is compared against both zero and the margin:

```
         -margin       0       +margin
            |          |          |
    [---]   |          |          |         ==> FASTER  (beyond margin)
            |          |          |  [---]  ==> SLOWER  (beyond margin)
            |   [----------]      |         ==> EQUIVALENT (CI within margin)
            |      [--]           |         ==> EQUIVALENT (excludes zero, but trivial)
   [------------]  |              |         ==> INCONCLUSIVE (need more data)
```

**Equivalent** means the entire CI fits within the margin. The difference is
provably smaller than what matters, whether or not it's statistically
significant.

**Faster / Slower** means the CI excludes zero and extends beyond the margin. A
real, meaningful change.

**Inconclusive** means the CI is too wide to decide. More batches would narrow
it.

#### Calibrating the Margin

The default 2% margin is reasonable for most benchmarks, but the noise floor
varies. Fast microbenchmarks may have < 1% noise; slow benchmarks with GC
pressure may have 3-5%.

To calibrate, run a self-comparison where baseline and current are identical:

```bash
# Run identical code against itself
benchforge my-bench.ts --baseline --batches 50

# Check the CI -- e.g. +0.3% [-1.8%, +2.4%]
# The max absolute bound (2.4%) is your noise floor.
# Round up for the margin.
benchforge my-bench.ts --baseline --batches 50 --equiv-margin 3
```

Use `--equiv-margin 0` to disable equivalence testing and fall back to the
simple CI-excludes-zero approach.

### Batch Count

Benchforge warns when a comparison has fewer than 20 batches and disables the
direction indicator. For reliable comparisons, use 40+ batches. More batches
narrow the confidence interval, the tradeoff is increased time for tests.

## Reading the Results

Results are displayed as: `+2.5% [-1.2%, +6.1%]`

- The first number is the observed percentage difference (positive = slower)
- The bracketed range is the 95% confidence interval
- Color indicates direction: green for faster, red for slower, gray for
  uncertain

The UI display shows even more information.

**"Uncertain" or "Inconclusive"** means the CI is too wide to decide. The fix is
more batches -- each additional batch is another independent observation that
narrows the interval. Aim for 40+ batches for reliable results.

**Median and mean tell different stories?** Check whether GC overhead changed.
If mean regressed but median didn't, allocation patterns likely shifted. Both
numbers matter -- median for algorithmic cost, mean for real-world throughput.
