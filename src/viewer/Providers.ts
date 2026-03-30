/** Feature flags and settings received from the server or inferred from an archive. */
export interface ViewerConfig {
  editorUri: string | null;
  hasReport: boolean;
  hasProfile: boolean;
  hasTimeProfile: boolean;
}

/** Serialized `.benchforge` archive containing report data, profiles, and sources. */
export interface ArchiveData {
  schema?: number;
  profile: unknown;
  timeProfile: unknown;
  report: unknown;
  sources: Record<string, string>;
  metadata?: { timestamp: string; benchforgeVersion: string };
}

/** Abstraction over data sources (live server or static archive). */
export interface DataProvider {
  readonly config: ViewerConfig;
  fetchReportData(): Promise<unknown>;
  fetchSource(url: string): Promise<string>;
  // LATER once we replace the speedscope iframe with an integrated viewer,
  // we can pass profile data directly instead of returning URLs.
  profileUrl(type: "alloc" | "time"): string | null;
  createArchive(): Promise<{ blob: Blob; filename: string }>;
}

/** Fetches data from the live CLI viewer HTTP server. */
export class ServerProvider implements DataProvider {
  constructor(readonly config: ViewerConfig) {}

  /** Fetch the server config and return a ready-to-use provider. */
  static async create(): Promise<ServerProvider> {
    const resp = await fetch("/api/config");
    return new ServerProvider(await resp.json());
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

  profileUrl(type: "alloc" | "time"): string | null {
    if (type === "alloc") return this.config.hasProfile ? "/api/profile" : null;
    return this.config.hasTimeProfile ? "/api/profile/time" : null;
  }

  async createArchive(): Promise<{ blob: Blob; filename: string }> {
    const resp = await fetch("/api/archive", { method: "POST" });
    if (!resp.ok) throw new Error("Archive failed");
    const disp = resp.headers.get("Content-Disposition") || "";
    const match = disp.match(/filename="?(.+?)"?$/);
    const filename = match?.[1] || "benchforge-archive.benchforge";
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

  /** Return a blob URL for the profile, lazily created and cached. */
  profileUrl(type: "alloc" | "time"): string | null {
    const isAlloc = type === "alloc";
    const data = isAlloc ? this.archive.profile : this.archive.timeProfile;
    if (!data) return null;
    let url = this.blobUrls.get(type);
    if (!url) {
      url = URL.createObjectURL(
        new Blob([JSON.stringify(data)], { type: "application/json" }),
      );
      this.blobUrls.set(type, url);
    }
    return url;
  }

  async createArchive(): Promise<{ blob: Blob; filename: string }> {
    const json = JSON.stringify(this.archive);
    const blob = new Blob([json], { type: "application/json" });
    const ts =
      this.archive.metadata?.timestamp ||
      new Date().toISOString().replace(/[:.]/g, "-");
    return { blob, filename: `benchforge-${ts}.benchforge` };
  }
}
