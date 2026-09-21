/**
 * Is there a newer Opifer? The server asks the npm registry for the latest
 * `@opifer/cli` once a day (never more, never with any data of the company)
 * and the health check, the interface and `o4r doctor` show the answer.
 * `updates.check: false` in the configuration turns it off.
 */

export const REGISTRY_URL = "https://registry.npmjs.org/@opifer/cli/latest";

/** Compares two versions like 1.2.3 (pre-release tags ignored): negative when a < b, zero when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface UpdateStatus {
  /** The version running here. */
  current: string;
  /** The latest version on npm, or null when unknown (offline, check disabled, not checked yet). */
  latest: string | null;
  /** True when `latest` is newer than `current`. */
  available: boolean;
  checkedAt: string | null;
}

export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** Asks the registry for the latest version; null when the network or the registry does not answer. */
export async function fetchLatestVersion(fetcher: Fetcher = fetch, timeoutMs = 4000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(REGISTRY_URL, { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class UpdateCheck {
  private latest: string | null = null;
  private checkedAt: Date | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly current: string,
    private readonly options: { enabled?: boolean; intervalMs?: number; fetcher?: Fetcher } = {},
  ) {}

  get enabled(): boolean {
    return this.options.enabled !== false;
  }

  status(): UpdateStatus | null {
    if (!this.enabled) return null;
    return {
      current: this.current,
      latest: this.latest,
      available: this.latest !== null && compareVersions(this.latest, this.current) > 0,
      checkedAt: this.checkedAt?.toISOString() ?? null,
    };
  }

  async refresh(): Promise<UpdateStatus | null> {
    if (!this.enabled) return null;
    const latest = await fetchLatestVersion(this.options.fetcher);
    if (latest) {
      this.latest = latest;
      this.checkedAt = new Date();
    }
    return this.status();
  }

  /** Checks shortly after the start, then once a day. */
  start(): void {
    if (!this.enabled || this.timer) return;
    const interval = this.options.intervalMs ?? 24 * 60 * 60 * 1000;
    const first = setTimeout(() => void this.refresh(), Math.min(30_000, interval));
    first.unref();
    this.timer = setInterval(() => void this.refresh(), interval);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
