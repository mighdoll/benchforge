/** Feature flags and settings received from the server or inferred from an archive. */
export interface ViewerConfig {
  editorUri: string | null;
  hasReport: boolean;
  hasProfile: boolean;
  hasTimeProfile: boolean;
  hasCoverage: boolean;
}

/** Per-function coverage entry at a source line */
export interface ViewerLineCoverage {
  startLine: number;
  functionName: string;
  count: number;
}

/** Coverage data keyed by source URL */
export type ViewerCoverageData = Record<string, ViewerLineCoverage[]>;

/** Minimal speedscope profile types needed by the viewer (avoids importing server-side exports). */
export interface ViewerSpeedscopeFrame {
  name: string;
  file?: string;
  line?: number;
  col?: number;
}

export interface ViewerSpeedscopeProfile {
  type: "sampled";
  unit: "bytes" | "microseconds";
  samples: number[][];
  weights: number[];
}

export interface ViewerSpeedscopeFile {
  shared: { frames: ViewerSpeedscopeFrame[] };
  profiles: ViewerSpeedscopeProfile[];
}

/** Serialized `.benchforge` archive containing report data, profiles, and sources. */
export interface ArchiveData {
  schema?: number;
  profile: unknown;
  timeProfile: unknown;
  coverage?: unknown;
  report: unknown;
  sources: Record<string, string>;
  metadata?: { timestamp: string; benchforgeVersion: string };
}

/** Abstraction over data sources (live server or static archive). */
export interface DataProvider {
  readonly config: ViewerConfig;
  fetchReportData(): Promise<unknown>;
  fetchSource(url: string): Promise<string>;
  fetchProfileData(
    type: "alloc" | "time",
  ): Promise<ViewerSpeedscopeFile | null>;
  fetchCoverageData(): Promise<ViewerCoverageData | null>;
  // LATER once we replace the speedscope iframe with an integrated viewer,
  // we can pass profile data directly instead of returning URLs.
  profileUrl(type: "alloc" | "time"): string | null;
  createArchive(): Promise<{ blob: Blob; filename: string }>;
}

/** Fetches data from the live CLI viewer HTTP server. */
export class ServerProvider implements DataProvider {
  private profileCache = new Map<
    string,
    Promise<ViewerSpeedscopeFile | null>
  >();

  readonly config: ViewerConfig;
  constructor(config: ViewerConfig) {
    this.config = config;
  }

  /** Fetch the server config and return a ready-to-use provider. */
  static async create(): Promise<ServerProvider> {
    const resp = await fetch("/api/config");
    return new ServerProvider((await resp.json()) as ViewerConfig);
  }

  async fetchReportData(): Promise<unknown> {
    const resp = await fetch("/api/report-data");
    if (!resp.ok) throw new Error("No report data: " + resp.status);
    return resp.json();
  }

  async fetchSource(url: string): Promise<string> {
    const resp = await fetch("/api/source?url=" + encodeURIComponent(url));
    if (!resp.ok) throw new Error("Source unavailable");
    return resp.text();
  }

  /** Fetch a speedscope profile, caching the result by type. */
  fetchProfileData(
    type: "alloc" | "time",
  ): Promise<ViewerSpeedscopeFile | null> {
    const url = this.profileUrl(type);
    if (!url) return Promise.resolve(null);
    let cached = this.profileCache.get(type);
    if (!cached) {
      cached = fetch(url).then(r =>
        r.ok ? (r.json() as Promise<ViewerSpeedscopeFile>) : null,
      );
      this.profileCache.set(type, cached);
    }
    return cached;
  }

  private coverageCache?: Promise<ViewerCoverageData | null>;

  fetchCoverageData(): Promise<ViewerCoverageData | null> {
    if (!this.config.hasCoverage) return Promise.resolve(null);
    this.coverageCache ??= fetch("/api/coverage").then(r =>
      r.ok ? (r.json() as Promise<ViewerCoverageData>) : null,
    );
    return this.coverageCache;
  }

  profileUrl(type: "alloc" | "time"): string | null {
    if (type === "alloc") return this.config.hasProfile ? "/api/profile" : null;
    return this.config.hasTimeProfile ? "/api/profile/time" : null;
  }

  /** Request a `.benchforge` archive from the server, extracting the filename from Content-Disposition. */
  async createArchive(): Promise<{ blob: Blob; filename: string }> {
    const resp = await fetch("/api/archive", { method: "POST" });
    if (!resp.ok) throw new Error("Archive failed");
    const disposition = resp.headers.get("Content-Disposition") || "";
    const nameMatch = disposition.match(/filename="?(.+?)"?$/);
    const filename = nameMatch?.[1] || "benchforge-archive.benchforge";
    return { blob: await resp.blob(), filename };
  }
}

/** Serves data from an in-memory `.benchforge` archive (drag-drop or URL). */
export class ArchiveProvider implements DataProvider {
  readonly config: ViewerConfig;
  private blobUrls = new Map<string, string>();
  private archive: ArchiveData;

  constructor(archive: ArchiveData) {
    this.archive = archive;
    this.config = {
      editorUri: null,
      hasReport: !!archive.report,
      hasProfile: !!archive.profile,
      hasTimeProfile: !!archive.timeProfile,
      hasCoverage: !!archive.coverage,
    };
  }

  async fetchReportData(): Promise<unknown> {
    if (!this.archive.report) throw new Error("No report data");
    return this.archive.report;
  }

  async fetchSource(url: string): Promise<string> {
    const source = this.archive.sources?.[url];
    if (source === undefined) throw new Error("Source unavailable");
    return source;
  }

  async fetchProfileData(
    type: "alloc" | "time",
  ): Promise<ViewerSpeedscopeFile | null> {
    const { profile, timeProfile } = this.archive;
    const data = type === "alloc" ? profile : timeProfile;
    return (data as ViewerSpeedscopeFile) ?? null;
  }

  async fetchCoverageData(): Promise<ViewerCoverageData | null> {
    return (this.archive.coverage as ViewerCoverageData) ?? null;
  }

  /** Return a blob URL for the profile, lazily created and cached. */
  profileUrl(type: "alloc" | "time"): string | null {
    const { profile, timeProfile } = this.archive;
    const data = type === "alloc" ? profile : timeProfile;
    if (!data) return null;
    let url = this.blobUrls.get(type);
    if (!url) {
      const json = JSON.stringify(data);
      const blob = new Blob([json], { type: "application/json" });
      url = URL.createObjectURL(blob);
      this.blobUrls.set(type, url);
    }
    return url;
  }

  async createArchive(): Promise<{ blob: Blob; filename: string }> {
    const json = JSON.stringify(this.archive);
    const blob = new Blob([json], { type: "application/json" });
    const fallbackDate = new Date().toISOString().replace(/[:.]/g, "-");
    const timestamp = this.archive.metadata?.timestamp || fallbackDate;
    return { blob, filename: `benchforge-${timestamp}.benchforge` };
  }
}
