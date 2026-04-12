/** Chrome Trace Event format (used by Perfetto and CDP tracing). */
export interface TraceEvent {
  /** Event type: M=metadata, C=counter, i=instant, B/E=begin/end, X=complete */
  ph: string;

  /** Timestamp in microseconds */
  ts: number;

  /** Process ID */
  pid?: number;

  /** Thread ID */
  tid?: number;

  /** Event category */
  cat?: string;

  name: string;

  /** Arbitrary event arguments */
  args?: Record<string, unknown>;

  /** Scope for instant events: "t"=thread, "p"=process, "g"=global */
  s?: string;

  /** Duration for complete events (microseconds) */
  dur?: number;
}
