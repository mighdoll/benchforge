/** Per-function execution counts from V8 Profiler.takePreciseCoverage.
 *  Works with both node:inspector (Node.js) and CDP (browser). */
export interface CoverageData {
  scripts: ScriptCoverage[];
}

/** Coverage data for a single script (file) */
export interface ScriptCoverage {
  url: string;
  functions: FunctionCoverage[];
}

/** Coverage data for a single function within a script */
export interface FunctionCoverage {
  functionName: string;
  ranges: CoverageRange[];
}

/** A byte-offset range within a function with its execution count */
export interface CoverageRange {
  startOffset: number;
  endOffset: number;
  count: number;
}
