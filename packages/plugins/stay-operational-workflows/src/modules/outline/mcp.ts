/**
 * Errors emitted by the brokered Outline MCP boundary.
 *
 * This module deliberately contains no HTTP client, bearer token, or secret
 * resolver. Callers supply an OutlineMcpPort backed by the exact approved
 * Paperclip MCP connection and tool set.
 */
export class OutlineMcpError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(code);
    this.name = "OutlineMcpError";
  }
}

export class OutlineAmbiguousWriteError extends OutlineMcpError {
  constructor(code = "outline_mcp_ambiguous_write_response", retryAfterMs: number | null = null) {
    super(code, true, retryAfterMs);
    this.name = "OutlineAmbiguousWriteError";
  }
}
