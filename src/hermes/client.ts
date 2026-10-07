import type { AppConfig } from "../config/index.js";

export interface HermesClient {
  readonly enabled: boolean;
  healthCheck(): Promise<{ online: boolean; detail: string }>;
}

export class DisabledHermesClient implements HermesClient {
  readonly enabled = false;
  async healthCheck() { return { online: false, detail: "disabled" }; }
}

export class HttpHermesClient implements HermesClient {
  readonly enabled = true;
  constructor(private readonly baseUrl: string, private readonly apiKey?: string) {}

  async healthCheck(): Promise<{ online: boolean; detail: string }> {
    try {
      const response = await fetch(new URL("/health", this.baseUrl), {
        method: "GET", headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
        signal: AbortSignal.timeout(3000),
      });
      return { online: response.ok, detail: response.ok ? "available" : "unavailable" };
    } catch { return { online: false, detail: "unavailable" }; }
  }
}

export function createHermesClient(config: AppConfig): HermesClient {
  if (!config.hermesEnabled || !config.hermesBaseUrl) return new DisabledHermesClient();
  return new HttpHermesClient(config.hermesBaseUrl, config.hermesApiKey);
}
