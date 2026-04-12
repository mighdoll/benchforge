## Coming from Tachometer

Tachometer and benchforge share the same core idea: open fresh browser
tabs, interleave A and B to cancel order effects, and compute a
confidence interval on the difference. Benchforge adds a two-level
structure — iterations grouped into batches — so it can detect and
discard noisy groups.

```bash
benchforge --url http://localhost:8080/current.html \
  --baseline-url http://localhost:8080/baseline.html \
  --batches 10 --iterations 5
```

### Visualizations and Integrated Data

The viewer shows charts of performance data distributions, 
not just numeric summary statistics.
The charts can quickly reveal if your performance is bimodal,
or long tailed, or any number of other interesting
details that aren't obvious from just mean + confidence interval.

Beyond timing data, benchforge also adds instrumentation
to correlate timing with memory allocation
profiles, heap growth, GC events, function call counts, V8 optimization tiers,
etc. An integrated view helps to identify the
causes behind performance changes and opportunities
for further improvements.

### Statistics

Benchforge uses non-parametric bootstrap rather than tachometer's
Student's t. This has several practical consequences.

**Robust to skewed distributions.** Performance data is characteristically
right-skewed: most iterations are fast, with occasional slow ones from GC
pauses, scheduling jitter, or page faults. Student's t 
reports only the mean, which is pulled by tail events. 
Benchforge can report any percentile and by default reports median alongside mean, 
giving a central tendency that isn't distorted by
intermittent collection. Benchforge reports are configurable, 
but typically report percentiles like p90 or p99 as well.

Also, benchforge will show you distributions visually
which often helps to identify the causes of performance variation.

**Can confirm equivalence, not just fail to find a difference.** 
When you run a comparison benchmark, there are three statistical results:
1) faster/slower, 2) no change, 3) insufficient data. 
Tachometer doesn't distinguish the latter two.

Benchforge adds an equivalence margin (`--equiv-margin 2` by default).
If the CI of the measured statistics falls entirely within the margin,
the verdict is "equivalent," 
positive confirmation that the difference is too small to matter. 
Since typical cases resolve quickly when the difference is 
genuinely small, this saves time in running perf tests.
Distinguishing "insufficient data" is a useful signal too, it tells you
you might usefully reduce noise or increase batches to improve test quality.

**More robust on laptops.** On an everyday development machine, some
batches will be contaminated by background activity, a browser update
check, a backup job, a thermal throttle, etc. 
Because benchforge groups iterations into batches, it
can detect contamination at the batch level and drop the entire group.
Tukey trimming is on by default (`--no-batch-trim` to disable), dropping
batches whose means are more than 3× the interquartile range. This both
tightens the CI and makes results more reproducible outside of controlled
lab environments.

**Batching structure.** Benchforge groups measurements into batches. For
URL-based page load tests, each iteration opens a fresh tab, and a batch
groups several iterations (`--batches 10 --iterations 5` opens 50 tabs per
benchmark in groups of 5). For `__bench` pages, multiple iterations run
within a single tab. 

By grouping tests into batches and using more robust statistics, 
benchforge users can identify more subtle performance 
differences in less time.

### Node.js benchmarks

The same machinery works for NodeJs benchmarks, where each iteration
runs in a fresh worker process instead of a fresh tab, grouped into
batches the same way. For JavaScript libraries that run in both
Node and browser, Node uses the same v8 JavaScript engine as Chrome,
and is quicker to launch and run benchmark batches.