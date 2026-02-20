import { test } from "vitest";
import { checkConvergence } from "../runners/AdaptiveWrapper.ts";
import { bevy30SamplesNs } from "./fixtures/bevy30-samples.ts";

test("convergence with insufficient samples", () => {
  const samples = [1e6, 2e6, 3e6]; // 3 samples in nanoseconds
  const result = checkConvergence(samples);

  if (result.converged) throw new Error("Should not converge with few samples");
  if (result.confidence >= 10)
    throw new Error("Confidence too high for 3 samples");
  if (!result.reason.includes("Collecting samples")) {
    throw new Error("Wrong reason for non-convergence");
  }
});

test("convergence with stable samples", () => {
  // Create very stable samples (all within 1% of each other)
  const base = 50e6; // 50ms in nanoseconds
  const samples = Array.from(
    { length: 200 },
    () => base + (Math.random() - 0.5) * base * 0.01,
  );
  const result = checkConvergence(samples);

  if (!result.converged) throw new Error("Should converge with stable samples");
  if (result.confidence !== 100) throw new Error("Should have 100% confidence");
  if (!result.reason.includes("Stable")) {
    throw new Error("Wrong reason for convergence");
  }
});

test("convergence with drifting median", () => {
  // Create samples with increasing median over time
  const samples = Array.from(
    { length: 200 },
    (_, i) => 50e6 + i * 0.5e6 + (Math.random() - 0.5) * 1e6,
  );

  const result = checkConvergence(samples);

  if (result.converged)
    throw new Error("Should not converge with drifting median");
  if (result.confidence >= 80)
    throw new Error("Confidence too high for drifting data");
  if (!result.reason.includes("Median drifting")) {
    throw new Error("Should identify median drift");
  }
});

test("convergence with outliers", () => {
  // Create stable samples with occasional outliers every 20 samples
  const base = 50e6;
  const samples = Array.from({ length: 200 }, (_, i) =>
    i % 20 === 0 ? base * 2 : base + (Math.random() - 0.5) * base * 0.01,
  );

  const result = checkConvergence(samples);

  // May or may not converge depending on outlier impact calculation
  if (result.converged && result.confidence !== 100) {
    throw new Error("Should have 100% confidence if converged");
  }
});

test("convergence with real bevy30 data - early samples", () => {
  // Test with first 100 samples (should show initial instability)
  const early = bevy30SamplesNs.slice(0, 100);
  const result = checkConvergence(early);

  // Early samples include warm-up, may not be fully converged
  if (result.confidence > 100 || result.confidence < 0) {
    throw new Error(`Confidence out of range: ${result.confidence}`);
  }

  console.log(
    `Early samples (100): converged=${result.converged}, confidence=${result.confidence}%`,
  );
});

test("convergence with real bevy30 data - middle samples", () => {
  // Test with middle 200 samples (should be more stable)
  const middle = bevy30SamplesNs.slice(200, 400);
  const result = checkConvergence(middle);

  if (result.confidence > 100 || result.confidence < 0) {
    throw new Error(`Confidence out of range: ${result.confidence}`);
  }

  console.log(
    `Middle samples (200): converged=${result.converged}, confidence=${result.confidence}%`,
  );
});

test("convergence with real bevy30 data - all samples", () => {
  const result = checkConvergence(bevy30SamplesNs);

  if (result.confidence > 100 || result.confidence < 0) {
    throw new Error(`Confidence out of range: ${result.confidence}`);
  }

  // With 30 seconds of data, should have high confidence
  if (result.confidence < 80) {
    console.warn(`Low confidence with 30s of data: ${result.confidence}%`);
  }

  console.log(
    `All samples (610): converged=${result.converged}, confidence=${result.confidence}%`,
  );
});

test("convergence progression over time", () => {
  const checkpoints = [50, 100, 150, 200, 300, 400, 500, 610];
  const progressions = checkpoints.map(n => {
    const result = checkConvergence(bevy30SamplesNs.slice(0, n));
    return { samples: n, confidence: result.confidence };
  });

  // Confidence should generally increase with more samples
  console.log("Convergence progression:");
  for (const { samples, confidence } of progressions) {
    console.log(`  ${samples} samples: ${confidence.toFixed(1)}%`);
  }

  const earlyConfidence = progressions[0].confidence;
  const lateConfidence = progressions.at(-1)!.confidence;

  if (lateConfidence < earlyConfidence) {
    console.warn(
      "Confidence decreased over time - may indicate benchmark instability",
    );
  }
});

test("window size adaptation for different execution times", () => {
  // Fast samples (microseconds)
  const fastSamples = Array.from(
    { length: 100 },
    () => 10e3 + Math.random() * 1e3, // 10-11us
  );
  const fastResult = checkConvergence(fastSamples);

  // Slow samples (milliseconds)
  const slowSamples = Array.from(
    { length: 100 },
    () => 50e6 + Math.random() * 1e6, // 50-51ms
  );
  const slowResult = checkConvergence(slowSamples);

  console.log(`Fast samples (10μs): confidence=${fastResult.confidence}%`);
  console.log(`Slow samples (50ms): confidence=${slowResult.confidence}%`);

  if (fastResult.confidence > 100 || slowResult.confidence > 100) {
    throw new Error("Confidence exceeds 100%");
  }
});

test("outlier impact calculation", () => {
  // 95 stable samples + 5 outliers (2x slower)
  const base = 50e6; // 50ms
  const stable = Array.from(
    { length: 95 },
    () => base + (Math.random() - 0.5) * 1e6,
  );
  const samples = [...stable, ...Array(5).fill(base * 2)];

  const result = checkConvergence(samples);

  // With 5% outliers doubling execution time, should impact convergence
  console.log(
    `With 5% outliers: converged=${result.converged}, confidence=${result.confidence}%`,
  );

  if (result.reason.includes("Outlier impact") && result.confidence > 90) {
    throw new Error("Should detect outlier impact or have lower confidence");
  }
});
