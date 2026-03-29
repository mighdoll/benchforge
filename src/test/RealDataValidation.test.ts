import { test } from "vitest";
import { checkConvergence } from "../runners/AdaptiveWrapper.ts";
import {
  coefficientOfVariation,
  medianAbsoluteDeviation,
  percentile,
} from "../StatisticalUtils.ts";
import { bevy30SamplesMs, bevy30SamplesNs } from "./fixtures/bevy30-samples.ts";

test("bevy30 data characteristics", () => {
  const sortedMs = [...bevy30SamplesMs].sort((a, b) => a - b);

  const stats = {
    count: sortedMs.length,
    min: sortedMs[0],
    p25: percentile(sortedMs, 0.25),
    p50: percentile(sortedMs, 0.5),
    p75: percentile(sortedMs, 0.75),
    p95: percentile(sortedMs, 0.95),
    p99: percentile(sortedMs, 0.99),
    max: sortedMs[sortedMs.length - 1],
    mean: sortedMs.reduce((a, b) => a + b, 0) / sortedMs.length,
    cv: coefficientOfVariation(sortedMs),
    mad: medianAbsoluteDeviation(sortedMs),
  };

  console.log("Bevy30 benchmark statistics:");
  console.log(`  Samples: ${stats.count}`);
  console.log(`  Min: ${stats.min.toFixed(2)}ms`);
  console.log(`  P25: ${stats.p25.toFixed(2)}ms`);
  console.log(`  P50: ${stats.p50.toFixed(2)}ms`);
  console.log(`  P75: ${stats.p75.toFixed(2)}ms`);
  console.log(`  P95: ${stats.p95.toFixed(2)}ms`);
  console.log(`  P99: ${stats.p99.toFixed(2)}ms`);
  console.log(`  Max: ${stats.max.toFixed(2)}ms`);
  console.log(`  Mean: ${stats.mean.toFixed(2)}ms`);
  console.log(`  CV: ${(stats.cv * 100).toFixed(1)}%`);
  console.log(`  MAD: ${stats.mad.toFixed(2)}ms`);

  if (stats.count !== 610) throw new Error("Expected 610 samples");
  if (stats.min < 40 || stats.min > 100)
    throw new Error("Unexpected min value");
  if (stats.max < 50 || stats.max > 100)
    throw new Error("Unexpected max value");

  // Check for reasonable variation (not too noisy, not suspiciously stable)
  if (stats.cv < 0.01) console.warn("Very low variation - may be synthetic");
  if (stats.cv > 0.5) console.warn("Very high variation - may be unstable");
});

test("convergence at different time points matches CLI behavior", () => {
  // Simulate 5-second run (approximately 100 samples at ~50ms each)
  const samples5s = bevy30SamplesNs.slice(0, 100);
  const result5s = checkConvergence(samples5s);

  const msg5s = `5-second equivalent (100 samples): converged=${result5s.converged}, confidence=${result5s.confidence}%`;
  console.log(msg5s);

  // Should match what we saw in CLI: 100% convergence
  if (result5s.confidence !== 100)
    console.warn(
      `Expected 100% convergence at 5s, got ${result5s.confidence}%`,
    );

  // Simulate very short run (0.5 seconds, ~10 samples)
  const samples500ms = bevy30SamplesNs.slice(0, 10);
  const result500ms = checkConvergence(samples500ms);

  const msg500ms = `0.5-second equivalent (10 samples): converged=${result500ms.converged}, confidence=${result500ms.confidence}%`;
  console.log(msg500ms);

  // Should have low convergence like we saw in CLI
  if (result500ms.confidence > 20)
    console.warn(
      `Expected low convergence at 0.5s, got ${result500ms.confidence}%`,
    );
});

test("warm-up detection in real data", () => {
  const windowSize = 20;
  const windows: Array<{ start: number; median: number }> = [];

  for (let i = 0; i <= bevy30SamplesMs.length - windowSize; i += windowSize) {
    const window = bevy30SamplesMs.slice(i, i + windowSize);
    const median = percentile(window, 0.5);
    windows.push({ start: i, median });
  }

  // Find the window with highest median (likely during warm-up)
  const maxWindow = windows.reduce((max, w) =>
    w.median > max.median ? w : max,
  );
  const stableMedian = windows[windows.length - 1].median;

  console.log(`Warm-up analysis:`);
  const peak = `${maxWindow.median.toFixed(2)}ms at sample ${maxWindow.start}`;
  console.log(`  Highest median: ${peak}`);
  console.log(`  Stable median: ${stableMedian.toFixed(2)}ms`);
  const overhead = ((maxWindow.median / stableMedian - 1) * 100).toFixed(1);
  console.log(`  Warm-up overhead: ${overhead}%`);

  if (maxWindow.start === 0) {
    console.log("  Warm-up detected at start of benchmark");
  }
});

test("convergence stability over sliding windows", () => {
  const windowSize = 100;
  const step = 50;
  const history: Array<{ start: number; confidence: number }> = [];

  for (let i = windowSize; i <= bevy30SamplesNs.length; i += step) {
    const samples = bevy30SamplesNs.slice(0, i);
    const result = checkConvergence(samples);
    history.push({ start: i - windowSize, confidence: result.confidence });
  }

  const firstFull = history.findIndex(h => h.confidence === 100);

  if (firstFull !== -1) {
    const samplesNeeded = history[firstFull].start + windowSize;
    console.log(`First 100% convergence at ${samplesNeeded} samples`);

    const unstable = history.slice(firstFull).some(h => h.confidence < 100);
    if (unstable) {
      console.warn("Convergence became unstable after initially reaching 100%");
    } else {
      console.log(
        "Convergence remained stable at 100% after initial achievement",
      );
    }
  }
});

test("adaptive algorithm would stop at correct time", () => {
  const target = 95;
  const fallback = 80;
  const minSamples = 50;

  let stopAt = -1;
  let stopConfidence = 0;

  for (let i = minSamples; i <= bevy30SamplesNs.length; i++) {
    const samples = bevy30SamplesNs.slice(0, i);
    const result = checkConvergence(samples);

    if (result.converged && result.confidence >= target) {
      stopAt = i;
      stopConfidence = result.confidence;
      break;
    }

    // Check fallback condition (after minimum time)
    if (i >= 100 && result.confidence >= fallback) {
      stopAt = i;
      stopConfidence = result.confidence;
      break;
    }
  }

  if (stopAt !== -1) {
    const timeSec = ((stopAt * 50) / 1000).toFixed(1); // Approximate seconds
    console.log(`Adaptive would stop at:`);
    console.log(`  Samples: ${stopAt}`);
    console.log(`  Confidence: ${stopConfidence}%`);
    console.log(`  Estimated time: ${timeSec}s`);
  } else {
    console.log("Adaptive would run to maximum time");
  }

  // Should stop relatively quickly with this stable data
  if (stopAt > 200) {
    console.warn(
      "Takes many samples to converge - may indicate initial instability",
    );
  }
});
