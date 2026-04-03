# Statistical Methods in Benchforge

## The Problem: Noisy Measurements

Benchmark data has two kinds of variability that look similar but need
opposite treatment:

**Intermittent signals** -- GC pauses, JIT tier transitions, memory pressure.
These are real costs your code pays. A function that allocates more triggers
more GC, and that overhead is part of its true cost. These should be captured.

**Intermittent noise** -- other applications waking up, OS scheduling jitter,
thermal throttling, background updates. These have nothing to do with the code
under test. These should be rejected.

No single statistic handles both. Averaging captures GC but also captures
laptop noise. Median filters noise but also hides GC. Benchforge addresses
this at two levels: batches reject environmental noise from comparisons,
while multiple statistics reveal the full picture of a single benchmark.

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
noise -- it tells you how fast your algorithm runs *between* disruptions. This
is the "clean" speed of your code.

**Mean** is the amortized cost including everything -- GC pauses, JIT
compilation, the lot. It reflects the actual wall-clock throughput: total time
divided by iterations.

**When median and mean diverge**, that's informative. A large gap means GC or
other intermittent costs are significant. If a code change makes mean worse
while median stays flat, you likely increased allocation pressure -- a real
regression that median alone would hide.

**Tail percentiles** (p90, p99) show worst-case iteration behavior. High p99
relative to median indicates occasional expensive iterations, often from GC
pauses or JIT recompilation.

Point estimates are computed from pooled samples across batches, excluding
any batches rejected by Tukey trimming (see Comparison Statistics below).

## Comparison Statistics

When comparing against a baseline, the question changes from "how fast is this?"
to "did it get faster or slower, and by how much?"

### Block Bootstrap

Individual samples within a batch are correlated -- they share the same thermal
state, memory layout, and background load. Treating each sample as independent
would understate the true uncertainty. Instead, batches are the unit of
independence.

The block bootstrap works as follows:

1. Compute the per-batch mean for each batch (both baseline and current).
2. Tukey-trim using those means: remove batches whose mean falls outside
   3x IQR fences. Mean is used for trimming regardless of the target
   statistic because it's most sensitive to environmental disruption --
   median might look normal in a noisy batch while the mean gets pulled.
3. For kept batches, compute the target statistic per batch (mean for mean
   comparisons, median for p50, etc.).
4. For each of 10,000 bootstrap iterations:
   - Resample baseline batch values (with replacement)
   - Resample current batch values (with replacement)
   - Compute the percentage difference between their averages
5. The 2.5th and 97.5th percentiles of this distribution form the 95%
   confidence interval.

The point estimate (observed % difference) uses the pooled median across
samples from kept batches -- the same Tukey filtering applies to both the
point estimate and the CI, so they stay consistent. The CI width comes from
the batch-level resampling, reflecting between-batch environmental variance.

### Equivalence Margin

A confidence interval answers "what range of differences is plausible?" but
doesn't directly answer "is this change meaningful?" The equivalence margin
bridges that gap.

Traditional CI testing asks: does the CI exclude zero? But with enough batches,
even trivial noise (ASLR, scheduler jitter) can push the CI away from zero.
The result gets stuck at "slower" or "faster" when comparing identical code --
the test detects real differences but can never confirm equivalence.

The equivalence margin (`--equiv-margin`, default 2%) defines the smallest
difference that matters. The CI is compared against both zero and the margin:

```
         -margin       0       +margin
            |          |          |
    [---]   |          |          |        ==> FASTER  (beyond margin)
            |          |          | [---]  ==> SLOWER  (beyond margin)
            |   [----------]     |        ==> EQUIVALENT (CI within margin)
            |      [--]          |        ==> EQUIVALENT (excludes zero, but trivial)
   [------------]  |             |        ==> INCONCLUSIVE (need more data)
```

**Equivalent** means the entire CI fits within the margin. The difference is
provably smaller than what matters, whether or not it's statistically
significant.

**Faster / Slower** means the CI excludes zero and extends beyond the margin.
A real, meaningful change.

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

The block bootstrap resamples batch means, so the number of batches directly
determines CI quality. With too few batches, CIs are wide and unstable.

Benchforge warns when a comparison has fewer than 20 batches and disables the
direction indicator. For reliable comparisons, use 40+ batches. More batches
always narrow the CI further -- the only cost is wall-clock time.

### Batch Duration

Batch count controls CI width, but `--duration` controls what each batch
actually measures. Each batch starts with a fresh heap, so allocation builds
from zero. If the batch is too short, the heap may never fill enough to trigger
a full (major) GC -- the batch mean then reflects only young-generation
scavenges, missing the amortized cost of major collections entirely.

With medium-length batches, a full collection fires but exactly when it fires
varies from batch to batch. That timing jitter has a larger effect on the
per-batch mean when there's only one full GC in the batch. With longer batches,
multiple full collections happen and the per-batch mean stabilizes.

This matters most when you care about mean (amortized throughput). If you're
only tracking median, GC timing is less significant since median is robust to
individual pauses.

**Guidance:** if per-batch means have high variance, try increasing `--duration`
before adding more batches. Total measurement time is `duration x batches`, and
you can trade between them -- but longer batches give more stable per-batch
means, while more batches give tighter CIs. Start with `--duration 2` or higher
for benchmarks with significant allocation.

## Reading the Results

Results are displayed as: `+2.5% [-1.2%, +6.1%]`

- The first number is the observed percentage difference (positive = slower)
- The bracketed range is the 95% confidence interval
- Color indicates direction: green for faster, red for slower, gray for
  uncertain

**"Uncertain" or "Inconclusive"** means the CI is too wide to decide. The fix
is more batches -- each additional batch is another independent observation that
narrows the interval. Aim for 40+ batches for reliable results.

**Median and mean tell different stories?** Check whether GC overhead changed.
If mean regressed but median didn't, allocation patterns likely shifted. Both
numbers matter -- median for algorithmic cost, mean for real-world throughput.
