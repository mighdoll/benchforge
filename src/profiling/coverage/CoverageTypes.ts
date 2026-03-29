/** Per-function execution counts from V8 Profiler.takePreciseCoverage.
 *  Works with both node:inspector (Node.js) and CDP (browser). */
export interface CoverageData {
  scripts: ScriptCoverage[];
}

export interface ScriptCoverage {
  url: string;
  functions: FunctionCoverage[];
}

export interface FunctionCoverage {
  functionName: string;
  ranges: CoverageRange[];
}

export interface CoverageRange {
  startOffset: number;
  endOffset: number;
  count: number;
}
