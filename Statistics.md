# Statistical Methods

This document describes the statistical methods benchforge uses to turn noisy
timing measurements into confidence intervals and verdicts.

## Challenges in analyzing benchmark data

**A result is a distribution, not a number.** The time to run your code is not a
single number. Each iteration takes a slightly different amount of time, and
together those measurements form a distribution: usually skewed toward slower
times, and sometimes split into two modes (a fast path and a slower collection
path). A change to your code need not affect that distribution evenly. A little slower on average yet much faster on the slow cases
is a very different result from a little slower on average yet faster on the fast
cases, even though both report the same change in the mean. So benchforge reports
the whole distribution and compares it at each percentile, not just at the
average. Whether typical throughput or worst case latency matters more is your call;
benchforge's job is to show where a change actually landed.

**Signal versus noise.** A benchmark's measured time varies, and that variation
comes in two kinds. Some of it is *signal*: real cost your code pays, such as
garbage collection pauses, just-in-time recompilation, or memory pressure. A
function that allocates more triggers more collection, and that time is part of
its true cost, so it should be captured. The rest is *noise*: variation unrelated
to your code, such as another process waking up, OS scheduling, or thermal
throttling, which should be rejected.

No single summary statistic can capture the signal while rejecting the noise. The
average includes the real collection cost, but a one-off noise spike drags it up
too. The median ignores that spike, but it also hides the collection cost you
wanted to measure. Benchforge's answer is not a better statistic but a set of
methods that reduce the noise and measure what is left: it interleaves and pairs
the two versions, groups their measurements into batches, and rejects batches
spoiled by an outlier. Whatever noise remains shows up as width in the confidence
interval rather than as a wrong verdict.

## Batches

A single timing sample is not independent of its neighbors: consecutive iterations
likely share the same CPU frequency, thermal state, cache contents, and background
load.
Methods that assume independent observations would credit the data with more
information than it holds and report a confidence interval that is overconfidently
narrow.

Benchforge groups measurements into **batches** and treats the batch, not the
individual sample, as the unit of independence. For a baseline comparison it runs
several interleaved rounds, alternating which version goes first on alternate rounds
so that any advantage to whichever version runs second (a warmer cache) cancels over
the run. The first batch is dropped by default (`--warmup-batch` keeps it): it
alone runs against a cold machine, before the OS page cache, CPU caches, and clock
speed have warmed up. That is a one-time cost of the harness, not of your program.
Your program's own warmup (JIT tiering, heap growth, GC) is not filtered out;
benchforge measures it in every batch on purpose. Dropping the first batch removes
this cold-start artifact without discarding the program's lifecycle cost.

Batches also preserve *pairing*: the baseline and current runs of one round happen
in the same neighborhood of machine state, so comparing them within the round
cancels much of the drift they share. More batches narrow the interval, roughly as
one over the square root of the batch count; [Calibration.md](Calibration.md)
covers how many batches to run and how long each should be.

Flags: `--batches N` sets the number of rounds; `--warmup-batch` keeps the first
batch.

## Confidence intervals: the bootstrap

A **confidence interval** answers a simple question: if we reran the benchmark, how
much would the result move? Benchforge computes it with a **bootstrap**. Rather
than assume the data follow a bell curve (timings do not; they are skewed), the
bootstrap resamples the data already collected, many times over (10,000 by
default), recomputes the statistic on each resample, and takes the middle 95% of
those results as the interval.

For batched data, benchforge resamples **whole batches**, not individual samples.
This is a **block bootstrap**, the standard bootstrap variant for correlated or
time-series data. Samples within a batch are not
independent: noise is time-correlated, so nearby samples tend to move together.
Resampling individual samples would treat that shared movement as if it were
independent evidence and report an overconfidently narrow interval. Resampling
whole batches keeps the correlation intact, so the interval reflects only the
independent information the run actually holds. Minimum and maximum are reported as
observed and are not bootstrapped.

## Comparing two versions

With a baseline, the question changes from "how fast is this?" to "did it get
faster or slower, and by how much?". Benchforge answers with a **paired**
comparison.

The baseline and current runs of one round ran back to back, in the same
neighborhood of machine state, so a disturbance that hit that round tends to hit
both. Each bootstrap resample draws the same set of rounds for both versions,
computes the statistic on each side, and takes the percentage difference. The
drift shared within a round appears on both sides and largely cancels in the
difference, so the interval reflects how consistently current differs from
baseline rather than how much the machine wandered.

For the difference, every statistic (the mean and each percentile) is computed by
pooling the samples of the drawn batches and recomputing the statistic on that
pool, so the interval measures the same quantity as the point estimate. If a round
is a slow outlier on either version it is dropped from both, so the two sides always
compare the same rounds.

Each version's own interval measures how much that version varies on its own; the
paired difference interval measures the change between them. Note that because pairing
cancels the noise the two share, the paired comparison can still show a clear difference even when
the versions' own intervals overlap.

Flags: `--baseline-url` (browser); Node suites name the baseline variant with
`baselineVariant`.

## The verdict and the equivalence margin

A confidence interval says which differences are plausible, but not whether a
difference is real or just measurement noise. Every setup has a noise floor: run
enough batches and even a comparison of identical code produces an interval that
clears zero. A plain test of whether the interval clears zero would then report
faster or slower for a difference that is really just noise.

Telling a real difference from noise takes two things. First, a confidence interval that reflects only what
the measured data supports, which is what the batches and block bootstrap above
provide. Second, a check that a difference the interval is confident about is
larger than the noise floor, and not just noise measured precisely. The
**equivalence margin** is that second check: a band around zero the size of the
noise floor. The verdict comes from where the *entire* interval sits relative to
the noise band:

```
         -margin       0       +margin
            |          |          |
    [---]   |          |          |         ==> FASTER       (entire interval past the margin)
            |          |          |  [---]  ==> SLOWER       (entire interval past the margin)
            |          | [-----]  |         ==> EQUIVALENT   (entire interval within the margin)
            |          |     [--------]     ==> INCONCLUSIVE (interval crosses a margin edge)
```

- **Faster / Slower**: the whole interval clears the margin, a resolved change.
- **Equivalent**: the whole interval fits inside the margin, so the difference is
  bounded below the threshold.
- **Inconclusive**: the interval crosses a margin edge, so the result is neither
  proven different nor proven equivalent. More batches would narrow it.

Testing the whole interval, rather than just the point estimate, is what keeps the
verdict stable: it changes only when the entire interval moves across a margin
edge, not when the point estimate jitters by a little.

By default the metric is a duration, where lower is better. A benchmark can define
its own metric instead, for instance a throughput rate such as operations 
per second, where higher is better, and configure benchforge accordingly. When
higher is better, the faster and slower directions are flipped, so that "Faster"
still marks the improvement.

The margin represents the noise floor of your setup: the largest difference it
cannot tell apart from noise. Calibration measures that floor directly (see
[Calibration.md](Calibration.md)); you can also set it by hand as an estimate. A
result within the margin is called equivalent because it cannot be distinguished
from noise, not because it is too small to matter.

Flags: `--equiv-margin PCT` (default 2; `0` disables the band, reducing the test
to whether the interval excludes zero).

## Outlier trimming

Before computing intervals, benchforge drops batches that are slow outliers, the
ones most likely contaminated by an environmental spike. It ranks the batch
averages, measures their typical spread (the interquartile range), and drops any
batch slower than the third quartile by more than three times that spread (a Tukey
fence). Only slow outliers are removed; a batch that ran unusually fast reflects
less noise, not more, so it is kept. To avoid over-trimming when the batches are
already tightly clustered, the spread used for the fence is floored at 2% of the
median.

The report's **Noise rejection** toggle turns trimming off (and back on) so you can
see how much the dropped batches mattered; `--no-batch-trim` does the same from the
command line.

## Glossary

Standard terms, for readers who want the formal names.

- **[Bootstrap](https://en.wikipedia.org/wiki/Bootstrapping_(statistics))** --
  estimating uncertainty by resampling the observed data, without assuming a
  distribution.
- **[Block bootstrap](https://en.wikipedia.org/wiki/Block_bootstrap)** -- a
  bootstrap that resamples whole blocks (here, batches) so correlation within a
  block is preserved.
- **[Confidence interval](https://en.wikipedia.org/wiki/Confidence_interval)** --
  a range that would contain the true value in a stated fraction (here 95%) of
  repeated runs.
- **[Percentile](https://en.wikipedia.org/wiki/Percentile)** -- the value below
  which a given fraction of samples fall (p50 is the median).
- **[Interquartile range](https://en.wikipedia.org/wiki/Interquartile_range)** --
  the spread between the 25th and 75th percentiles, used by the Tukey fence for
  outlier trimming.

## Related techniques

Benchforge's methods have named analogues in statistics and metrology:

- The whole interval verdict rule is **equivalence testing** (the two one-sided
  tests, or TOST), and the **equivalence margin** is the
  [non-inferiority or equivalence bound](https://en.wikipedia.org/wiki/Equivalence_test)
  it tests against, close to a minimum detectable effect. Other fields set that
  bound from what an effect *means* (a smallest effect size of interest, or a
  region of practical equivalence); benchforge sets it from what the setup can
  *resolve*, the measurement noise floor.
- **Calibration** is a measurement-system repeatability study, close to
  [gauge R&R](https://en.wikipedia.org/wiki/ANOVA_gauge_R%26R): run a known-zero
  comparison and measure how much the apparatus itself moves. The **noise floor**
  is the spread it finds, including run-to-run drift that a single run's interval
  cannot see.
