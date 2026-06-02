/** Individual GC event for visualization */
export interface GcEvent {
  /** Offset from collection start (ms) - can be negative for warmup GCs */
  offset: number;
  /** Duration of GC pause (ms) */
  duration: number;
}

/** GC time measured by Node's performance hooks */
export interface NodeGCTime {
  inRun: number;
  before: number;
  after: number;
  total: number;
  collects: number;
  /** Individual GC events during sample collection (for visualization) */
  events: GcEvent[];
}
