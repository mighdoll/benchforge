#!/usr/bin/env node
/**
 * Fixture for testing heap attribution stability under --jitless.
 * Run with: node --jitless --expose-gc <this-file> <variant> [--no-gc-include]
 *
 * Tries multiple strategies to reproduce attribution instability.
 */
import { Session } from "node:inspector/promises";

const variant = process.argv[2] || "A";
const noGcInclude = process.argv.includes("--no-gc-include");

// --- Heap sampling ---

async function withHeapSampling(opts, fn) {
  const session = new Session();
  session.connect();
  try {
    const params = {
      samplingInterval: opts.samplingInterval ?? 1,
      stackDepth: opts.stackDepth ?? 64,
    };
    if (!noGcInclude) {
      params.includeObjectsCollectedByMinorGC = true;
      params.includeObjectsCollectedByMajorGC = true;
    }
    await session.post("HeapProfiler.startSampling", params);
    const result = await fn();
    const { profile } = await session.post("HeapProfiler.stopSampling");
    return { result, profile };
  } finally {
    session.disconnect();
  }
}

// --- Target functions ---

/** Build a ~50KB string dynamically (not .repeat) then regex-replace */
function regexOnDynamicString() {
  let big = "";
  for (let i = 0; i < 500; i++) big += "x".repeat(100) + String(i);
  return big.replace(/x{10}/g, (m) => "y".repeat(m.length));
}

/** Same work but different function identity */
function regexOnDynamicString2() {
  let big = "";
  for (let i = 0; i < 500; i++) big += "z".repeat(100) + String(i);
  return big.replace(/z{10}/g, (m) => "w".repeat(m.length));
}

/** Shared helper — allocation could land on caller depending on attribution */
function buildLargeString(char, count) {
  let s = "";
  for (let i = 0; i < count; i++) s += char.repeat(100) + String(i);
  return s;
}

function processViaHelper1() {
  const s = buildLargeString("a", 500);
  return s.replace(/a{10}/g, (m) => "b".repeat(m.length));
}

function processViaHelper2() {
  const s = buildLargeString("c", 500);
  return s.replace(/c{10}/g, (m) => "d".repeat(m.length));
}

// --- Variant work (interleaved with targets) ---

function variantGarbage() {
  if (variant === "A") {
    // Minimal
    return [1, 2, 3];
  } else if (variant === "B") {
    // Heavy string garbage — may trigger minor GC
    const arr = [];
    for (let i = 0; i < 3000; i++) arr.push("g".repeat(200) + i);
    return arr;
  } else if (variant === "C") {
    // Object + array garbage — different GC pressure
    const objs = [];
    for (let i = 0; i < 2000; i++) objs.push({ k: new Array(20).fill(i) });
    return objs;
  } else {
    // Typed array garbage — triggers old-space allocation
    const arrs = [];
    for (let i = 0; i < 500; i++) arrs.push(new Float64Array(128));
    return arrs;
  }
}

// --- Profile analysis ---

function flattenProfile(profile) {
  const sites = [];

  function walk(node, stack) {
    const { functionName, url, lineNumber, columnNumber } = node.callFrame;
    const fn = functionName || "(anonymous)";
    const frame = { fn, url: url || "", line: lineNumber + 1, col: columnNumber ?? -1 };
    const newStack = [...stack, frame];
    if (node.selfSize > 0) {
      const site = { ...frame, bytes: node.selfSize, nodeId: node.id, samples: [] };
      sites.push(site);
    }
    for (const child of node.children || []) walk(child, newStack);
  }
  walk(profile.head, []);

  // Attach raw samples
  if (profile.samples) {
    const idToSites = new Map();
    for (const site of sites) {
      const arr = idToSites.get(site.nodeId) || [];
      arr.push(site);
      idToSites.set(site.nodeId, arr);
    }
    for (const sample of profile.samples) {
      const matching = idToSites.get(sample.nodeId);
      if (matching) for (const site of matching) site.samples.push(sample);
    }
  }

  return sites.sort((a, b) => b.bytes - a.bytes);
}

function aggregateByFn(sites) {
  const byFn = new Map();
  for (const site of sites) {
    const existing = byFn.get(site.fn);
    if (existing) {
      existing.bytes += site.bytes;
      existing.sampleCount += site.samples?.length ?? 0;
    } else {
      byFn.set(site.fn, {
        fn: site.fn, url: site.url, line: site.line,
        bytes: site.bytes, sampleCount: site.samples?.length ?? 0,
      });
    }
  }
  return [...byFn.values()].sort((a, b) => b.bytes - a.bytes);
}

// --- Main ---

async function main() {
  if (globalThis.gc) globalThis.gc();

  const { profile } = await withHeapSampling(
    { samplingInterval: 1, stackDepth: 64 },
    () => {
      const results = [];
      for (let i = 0; i < 10; i++) {
        // Target work
        results.push(regexOnDynamicString());
        results.push(regexOnDynamicString2());
        // Interleaved variant garbage (may shift GC timing)
        variantGarbage();
        // Shared helper (attribution could go to caller or helper)
        results.push(processViaHelper1());
        results.push(processViaHelper2());
        // More variant garbage
        variantGarbage();
      }
      return results;
    },
  );

  const allSites = flattenProfile(profile);
  const allAgg = aggregateByFn(allSites);
  const userSites = allSites.filter(s => s.url && !s.url.startsWith("node:"));
  const userAgg = aggregateByFn(userSites);

  // Target functions
  const targets = [
    "regexOnDynamicString", "regexOnDynamicString2",
    "processViaHelper1", "processViaHelper2", "buildLargeString",
  ];
  const targetData = {};
  for (const name of targets) {
    const entry = userAgg.find(s => s.fn === name);
    targetData[name] = { bytes: entry?.bytes ?? 0, samples: entry?.sampleCount ?? 0 };
  }

  process.stdout.write(JSON.stringify({
    variant,
    noGcInclude,
    targets: targetData,
    totalSamples: profile.samples?.length ?? 0,
    allTopSites: allAgg.slice(0, 20).map(s => ({
      fn: s.fn, bytes: s.bytes, samples: s.sampleCount, url: s.url, line: s.line,
    })),
  }) + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
