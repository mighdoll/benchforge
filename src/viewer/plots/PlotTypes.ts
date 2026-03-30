export interface Sample {
  benchmark: string;
  value: number;
  iteration: number;
}

export interface TimeSeriesPoint {
  benchmark: string;
  iteration: number;
  value: number;
  isWarmup: boolean;
  optStatus?: number;
}

export interface HeapPoint {
  benchmark: string;
  iteration: number;
  value: number;
}

/** GcEvent flattened with benchmark name for multi-series plots */
export interface FlatGcEvent {
  benchmark: string;
  sampleIndex: number;
  duration: number;
}

/** PausePoint flattened with benchmark name for multi-series plots */
export interface FlatPausePoint {
  benchmark: string;
  sampleIndex: number;
  durationMs: number;
}
