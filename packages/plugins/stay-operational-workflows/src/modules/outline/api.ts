import type { OutlineApiPort, OutlineDocument } from "./types.js";

export class OutlineApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(code);
    this.name = "OutlineApiError";
  }
}

export class OutlineAmbiguousWriteError extends OutlineApiError {
  constructor(code = "outline_ambiguous_write_response", retryAfterMs: number | null = null) {
    super(code, true, retryAfterMs);
    this.name = "OutlineAmbiguousWriteError";
  }
}

interface OutlineApiEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: string;
}

function normalizeDocument(value: unknown): OutlineDocument {
  if (!value || typeof value !== "object") {
    throw new OutlineApiError("outline_response_schema_invalid", false);
  }
  const document = value as Record<string, unknown>;
  if (
    typeof document.id !== "string" ||
    typeof document.collectionId !== "string" ||
    typeof document.title !== "string" ||
    typeof document.text !== "string"
  ) {
    throw new OutlineApiError("outline_response_schema_invalid", false);
  }
  return {
    id: document.id,
    collectionId: document.collectionId,
    parentDocumentId: typeof document.parentDocumentId === "string" ? document.parentDocumentId : null,
    title: document.title,
    text: document.text,
    url: typeof document.url === "string" ? document.url : null,
    updatedAt: typeof document.updatedAt === "string" ? document.updatedAt : null,
  };
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export class OutlineHttpApi implements OutlineApiPort {
  private readonly apiBaseUrl: string;

  constructor(
    apiBaseUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {
    const url = new URL(apiBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new OutlineApiError("outline_api_url_not_https", false);
    }
    if (!token.trim()) {
      throw new OutlineApiError("outline_token_missing", false);
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    url.search = "";
    url.hash = "";
    this.apiBaseUrl = url.toString();
  }

  async getDocument(id: string): Promise<OutlineDocument | null> {
    const response = await this.request("documents.info", { id }, false, true);
    return response === null ? null : normalizeDocument(response);
  }

  async createDocument(input: {
    id: string;
    collectionId: string;
    parentDocumentId: string;
    title: string;
    text: string;
  }): Promise<OutlineDocument> {
    return normalizeDocument(await this.request("documents.create", { ...input, publish: true }, true));
  }

  async updateDocument(input: { id: string; title: string; text: string }): Promise<OutlineDocument> {
    return normalizeDocument(await this.request("documents.update", input, true));
  }

  private async request(
    method: string,
    body: Record<string, unknown>,
    mutating: boolean,
    notFoundAsNull = false,
  ): Promise<unknown | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(new URL(method, this.apiBaseUrl), {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      if (mutating) throw new OutlineAmbiguousWriteError();
      throw new OutlineApiError("outline_transport_failure", true);
    } finally {
      clearTimeout(timeout);
    }

    if (notFoundAsNull && response.status === 404) return null;
    if (response.status === 429) {
      throw new OutlineApiError("outline_rate_limited", true, retryAfterMs(response));
    }
    if (mutating && response.status === 409) {
      throw new OutlineAmbiguousWriteError("outline_document_conflict_requires_reconciliation");
    }
    if (mutating && response.status >= 500) {
      throw new OutlineAmbiguousWriteError("outline_provider_5xx_ambiguous", retryAfterMs(response));
    }
    if (response.status >= 500) {
      throw new OutlineApiError("outline_provider_5xx", true, retryAfterMs(response));
    }
    if (response.status === 401 || response.status === 403) {
      throw new OutlineApiError("outline_auth_or_scope_denied", false);
    }
    if (!response.ok) {
      throw new OutlineApiError(`outline_provider_rejected_${response.status}`, false);
    }

    let envelope: OutlineApiEnvelope<unknown>;
    try {
      envelope = (await response.json()) as OutlineApiEnvelope<unknown>;
    } catch {
      if (mutating) throw new OutlineAmbiguousWriteError("outline_success_response_invalid");
      throw new OutlineApiError("outline_response_schema_invalid", false);
    }
    if (envelope.ok === false || envelope.data === undefined) {
      if (mutating) throw new OutlineAmbiguousWriteError("outline_success_response_ambiguous");
      throw new OutlineApiError("outline_response_schema_invalid", false);
    }
    return envelope.data;
  }
}
