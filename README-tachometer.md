## Coming from Tachometer

Tachometer and benchforge share the same core model: open a fresh browser
tab for each measurement, interleave A and B to cancel order effects, and
compute a confidence interval on the difference. Both reuse a single Chrome
instance across all samples.

```bash
benchforge --url http://localhost:8080/current.html \
  --baseline-url http://localhost:8080/baseline.html \
  --batches 50
```

### Visualization and profiling

Beyond timing, benchforge instruments the browser to collect allocation
profiles, heap growth, GC events, call counts, and V8 optimization tiers.
The interactive viewer provides several visualizations to analyze
performance details that are otherwise hard to find.

### Statistics

Benchforge uses non-parametric bootstrap rather than tachometer's
Student's t. This has several practical consequences.

**Robust to skewed distributions.** Performance data is characteristically
right-skewed — most iterations are fast, with occasional slow ones from GC
pauses, scheduling jitter, or page faults. Student's t assumes normality
and reports only the mean, which is pulled by tail events. 
Benchforge can report any percentile and by default reports median alongside mean, 
giving a central tendency that isn't distorted by
intermittent collection. More, you can see the distributions visually,
and often identify the causes of performance variation.

**Can confirm equivalence, not just fail to find a difference.** 
When you run a comparison benchmark, there are three statistical results:
1) faster/slower, 2) no change, 3) insufficient data. 
Tachometer can't distinguish the latter two.

Benchforge adds an equivalence margin (`--equiv-margin 2` by default).
If the CI falls entirely within ±2%, the verdict is "equivalent" — a
positive confirmation that the difference is too small to matter. 
The "insufficient data" verdict is a useful signal too — it tells you
to reduce noise or increase batches rather than guessing.
And typical equality cases resolve quickly when the difference is 
genuinely small, which saves time.

**More robust on laptops.** On an everyday development machine, some
batches will be contaminated by background activity — a browser update
check, a backup job, a thermal throttle. Tachometer folds all samples
into the result. Benchforge applies Tukey trimming (`--no-batch-trim` to
disable), dropping batches whose means fall outside 3× IQR fences. This
both tightens the CI and makes results more reproducible outside of
controlled lab environments.

**Finer resolution.** Benchforge runs multiple iterations within each
batch as well as multiple batches, each in its own tab. Per-batch
statistics have lower variance, so the confidence interval narrows
faster and detects smaller real differences.

The equivalence margin controls the sensitivity: set `--equiv-margin 0.5` 
to detect sub-1% regressions, or `--equiv-margin 0` for maximum sensitivity 
(same as tachometer's CI-excludes-zero rule, but with the narrower CIs that multi-iteration
batches provide).

### Node.js benchmarks

The same `--batches` machinery also works for file-based benchmarks, where each
batch runs in a fresh worker process instead of a fresh tab.
