## Coming from Tachometer

Tachometer and benchforge share the same core idea: run A and B in an
interleaved order, measure each many times, and report a confidence interval
(CI) on the difference. Benchforge differs in what it shows and how it models
those measurements: it visualizes distributions and profiles, compares more than
the mean, groups observations into batches, and can calibrate the measurement
floor of the benchmark setup.

```bash
benchforge --url http://localhost:8080/current.html \
  --baseline-url http://localhost:8080/baseline.html \
  --batches 40 --iterations 10
```

### Visual Diagnostics

The viewer shows charts of performance data distributions, not just numeric
summary statistics. The charts can quickly reveal if your performance is
bimodal, long tailed, or has other structure that isn't obvious from just mean
+ confidence interval.

Beyond timing data, benchforge also adds instrumentation to correlate timing
with memory allocation profiles, heap growth, GC events, function call counts,
V8 optimization tiers, etc. An integrated view helps identify the causes behind
performance changes and opportunities for further improvements.

### Not Just the Mean

Benchforge uses non-parametric bootstrap rather than Tachometer's Student's t.
This lets benchforge report confidence intervals (CI) for median and tail
percentiles too, not just average runtime.

**Robust to skewed distributions.** Performance data is characteristically
right-skewed: most iterations are fast, with occasional slow ones from GC
pauses, scheduling jitter, or page faults. Student's t
reports only the mean, which is pulled by tail events.
Benchforge can report any percentile and by default reports median alongside mean,
giving a central tendency that isn't distorted by
intermittent collection. Benchforge reports are configurable,
and typically report percentiles like p90 or p99 as well.

### Batches to Handle Temporal Noise

Benchmark noise often extends beyond one measurement: nearby measurements can
share the same machine, browser, heap, and scheduler state. Benchforge groups
measurements into batches to better estimate uncertainty and to more
effectively isolate time-correlated noise.

Tachometer interleaves measurements, then reports sample-level mean CIs.
That works best when those measurements are close to independent. When noise is
temporally correlated, the raw sample count can overstate the effective sample
size, making the CI too narrow. Benchforge groups interleaved measurements into
paired batch rounds and resamples those rounds for the comparison CI. Compared
with Tachometer's sample-level mean CI, benchforge can produce wider intervals
on the same raw data, but the interval better reflects what the benchmark setup
can actually resolve.

Batches also give benchforge ways to isolate time-correlated noise instead of
leaving it in the sample pool. The noise does not need to be a constant delay
on every sample. It only needs to affect the baseline and current batch
summaries in a comparable way, so the paired batch delta can cancel much of the
shared machine state before estimating the CI. When a disturbance contaminates
a whole time window, an explicit batch boundary also lets benchforge drop that
round from both sides instead of averaging the disturbance into the result.

See [Statistics.md](Statistics.md#batches) for details on the batch
model and block bootstrap.

### Verdicts and the Noise Floor

Real measurement setups are noisy, so the honest question is often not only
"which is faster?" but "can this setup even tell?" Benchforge answers both, and
can measure how much noise your setup has.

Tachometer can auto-sample until a mean-runtime CI is unambiguously on one side
of configured threshold points, such as `0%` or `10%`. That answers questions
like "is A faster or slower at all?" or "is the difference at least 10%?" If
Tachometer times out with a CI still crossing a configured threshold, the
condition is unresolved: the output CI is still useful, but the tool has not
separated equivalence from insufficient data for that threshold.

Benchforge turns this interval check into an explicit four-way verdict for each
reported statistic: faster, slower, equivalent, or inconclusive. With
`--equiv-margin 2`, a comparison is `equivalent` only when the entire CI fits
inside `[-2%, +2%]`; it is `inconclusive` when the CI straddles either margin
edge. That distinction matters because "we measured a small change precisely"
and "the data are too noisy to decide" both include zero, but they mean
different things.

`--equiv-margin` can be a user policy threshold, but benchforge can also
calibrate it from the benchmark setup itself. `--calibrate` runs current versus
current several times. The true difference is zero, so the spread of those
self-comparisons estimates the repeatability floor of the machine, benchmark,
metric, and run settings. Tachometer lets you configure threshold points for
auto-sampling, but it does not estimate those thresholds from repeated
known-zero comparisons.

### Node.js Benchmarks Too

The same machinery works for Node.js benchmarks, where each iteration runs in a
fresh worker process instead of a fresh tab, grouped into batches the same way.
For JavaScript libraries that run in both environments, Node uses the same V8
engine as Chrome and is quicker to launch and iterate, which makes it handy for
day-to-day comparisons.

Node also surfaces more than the browser path can. Browser GC numbers come from
CDP tracing, which reports collection counts and pause times only. In Node,
`--gc-stats` reads V8's `--trace-gc-nvp` and additionally reports bytes
allocated per iteration and the percentage of allocations promoted to the old
generation, a fuller picture of allocation pressure and object lifetime.
Allocation, CPU, and call-count profiling work in both environments.
