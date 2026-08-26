import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  sanitizeSentryIssue,
  SentryWorkflowConfigError,
  type LiveSentryAuthorization,
  type SanitizedSentryIssue,
  type SentryIssuePage,
  type SentryPilotConfig,
} from "./contracts.js";

export class ProviderRequestError extends Error {
  override readonly name = "ProviderRequestError";

  constructor(
    readonly provider: "sentry" | "slack",
    readonly code: string,
    readonly status: number | null,
    readonly retryAfterMs: number | null,
    readonly ambiguous: boolean,
  ) {
    super(`${provider} request failed: ${code}`);
  }
}

export interface SentryReadPort {
  readAuthorization(config: SentryPilotConfig, token: string): Promise<LiveSentryAuthorization>;
  listIssues(input: {
    config: SentryPilotConfig;
    token: string;
    start: string;
    end: string;
    cursor: string | null;
  }): Promise<SentryIssuePage>;
  countRecentOccurrences(input: {
    config: SentryPilotConfig;
    token: string;
    stableIssueId: string;
    start: string;
    end: string;
  }): Promise<number>;
}

export interface SlackNotifyPort {
  verifyIdentity(config: SentryPilotConfig, token: string): Promise<void>;
  postSummary(input: {
    config: SentryPilotConfig;
    token: string;
    text: string;
  }): Promise<{ channelId: string; timestamp: string }>;
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

function nextCursorFromLink(value: string | null, expected: URL): string | null {
  if (!value) return null;
  for (const entry of value.split(",")) {
    if (!/rel="next"/.test(entry) || !/results="true"/.test(entry)) continue;
    const match = entry.match(/<([^>]+)>/);
    if (!match) throw new ProviderRequestError("sentry", "invalid_pagination_link", null, null, false);
    const url = new URL(match[1]);
    if (url.protocol !== "https:" || url.origin !== expected.origin || url.pathname !== expected.pathname) {
      throw new ProviderRequestError("sentry", "pagination_scope_mismatch", null, null, false);
    }
    const cursor = url.searchParams.get("cursor");
    if (!cursor || cursor.length > 500 || !/^[A-Za-z0-9:._-]+$/.test(cursor)) {
      throw new ProviderRequestError("sentry", "invalid_pagination_cursor", null, null, false);
    }
    return cursor;
  }
  return null;
}

async function json(response: Response, provider: "sentry" | "slack"): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderRequestError(provider, "invalid_json", response.status, retryAfterMs(response), false);
  }
}

function sentryError(response: Response): ProviderRequestError {
  const status = response.status;
  return new ProviderRequestError(
    "sentry",
    status === 401 || status === 403
      ? "credential_or_scope_rejected"
      : status === 429 ? "rate_limited" : status >= 500 ? "provider_unavailable" : "request_rejected",
    status,
    retryAfterMs(response),
    false,
  );
}

export class SentryApiClient implements SentryReadPort {
  constructor(private readonly http: PluginContext["http"]) {}

  async readAuthorization(config: SentryPilotConfig, token: string): Promise<LiveSentryAuthorization> {
    const paths = [
      "/api/0/",
      `/api/0/organizations/${encodeURIComponent(config.sentry.organizationSlug)}/`,
      `/api/0/projects/${encodeURIComponent(config.sentry.organizationSlug)}/${encodeURIComponent(config.sentry.projectSlug)}/`,
      `/api/0/projects/${encodeURIComponent(config.sentry.organizationSlug)}/${encodeURIComponent(config.sentry.projectSlug)}/environments/${encodeURIComponent(config.sentry.environment)}/`,
    ];
    const bodies: Record<string, unknown>[] = [];
    let scopes: string[] = [];
    for (const path of paths) {
      const target = new URL(path, config.sentry.apiBaseUrl);
      let response: Response;
      try {
        response = await this.http.fetch(target.toString(), { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      } catch {
        throw new ProviderRequestError("sentry", "identity_network_failure", null, null, false);
      }
      if (!response.ok) throw sentryError(response);
      const payload = await json(response, "sentry");
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ProviderRequestError("sentry", "invalid_identity_response", response.status, null, false);
      bodies.push(payload as Record<string, unknown>);
      if (path === "/api/0/") scopes = [...new Set((response.headers.get("x-sentry-scopes") ?? "").split(",").map((scope) => scope.trim()).filter(Boolean))].sort();
    }
    const [principal, organization, project, environment] = bodies;
    return { principalId: String(principal.id ?? ""), scopes, organizationId: String(organization.id ?? ""), organizationSlug: String(organization.slug ?? ""), projectId: String(project.id ?? ""), projectSlug: String(project.slug ?? ""), environment: String(environment.name ?? "") };
  }

  async listIssues(input: {
    config: SentryPilotConfig;
    token: string;
    start: string;
    end: string;
    cursor: string | null;
  }): Promise<SentryIssuePage> {
    const url = new URL(`/api/0/organizations/${encodeURIComponent(input.config.sentry.organizationSlug)}/issues/`, input.config.sentry.apiBaseUrl);
    url.searchParams.set("project", input.config.sentry.projectId);
    url.searchParams.set("environment", input.config.sentry.environment);
    url.searchParams.set("start", new Date(input.start).toISOString());
    url.searchParams.set("end", new Date(input.end).toISOString());
    url.searchParams.set("query", "");
    url.searchParams.set("sort", "date");
    url.searchParams.set("limit", String(input.config.batchSize));
    url.searchParams.set("collapse", "owners");
    url.searchParams.append("collapse", "filtered");
    url.searchParams.append("collapse", "unhandled");
    if (input.cursor) url.searchParams.set("cursor", input.cursor);

    let response: Response;
    try {
      response = await this.http.fetch(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.token}`,
          accept: "application/json",
        },
      });
    } catch {
      throw new ProviderRequestError("sentry", "network_failure", null, null, false);
    }
    if (!response.ok) throw sentryError(response);
    const payload = await json(response, "sentry");
    if (!Array.isArray(payload)) {
      throw new ProviderRequestError("sentry", "invalid_issue_page", response.status, null, false);
    }
    const issues: SanitizedSentryIssue[] = [];
    for (const raw of payload) issues.push(sanitizeSentryIssue(raw, input.config));
    return {
      issues,
      nextCursor: nextCursorFromLink(response.headers.get("link"), url),
    };
  }

  async countRecentOccurrences(input: {
    config: SentryPilotConfig;
    token: string;
    stableIssueId: string;
    start: string;
    end: string;
  }): Promise<number> {
    let cursor: string | null = null;
    let count = 0;
    for (let page = 0; page < input.config.maxPages; page += 1) {
      const url = new URL(
        `/api/0/organizations/${encodeURIComponent(input.config.sentry.organizationSlug)}/issues/${encodeURIComponent(input.stableIssueId)}/events/`,
        input.config.sentry.apiBaseUrl,
      );
      url.searchParams.set("environment", input.config.sentry.environment);
      url.searchParams.set("start", new Date(input.start).toISOString());
      url.searchParams.set("end", new Date(input.end).toISOString());
      url.searchParams.set("full", "false");
      url.searchParams.set("per_page", "100");
      if (cursor) url.searchParams.set("cursor", cursor);
      let response: Response;
      try {
        response = await this.http.fetch(url.toString(), {
          method: "GET",
          headers: { authorization: `Bearer ${input.token}`, accept: "application/json" },
        });
      } catch {
        throw new ProviderRequestError("sentry", "network_failure", null, null, false);
      }
      if (!response.ok) throw sentryError(response);
      const payload = await json(response, "sentry");
      if (!Array.isArray(payload)) throw new ProviderRequestError("sentry", "invalid_event_page", response.status, null, false);
      for (const raw of payload) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const created = new Date((raw as Record<string, unknown>).dateCreated as string);
        if (!Number.isNaN(created.getTime()) && created >= new Date(input.start) && created <= new Date(input.end)) count += 1;
      }
      cursor = nextCursorFromLink(response.headers.get("link"), url);
      if (!cursor) return count;
    }
    throw new ProviderRequestError("sentry", "pagination_limit_exceeded", null, null, false);
  }
}

function parseSlackScopes(response: Response): string[] {
  return [...new Set((response.headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean))]
    .sort();
}

function slackApiError(payload: Record<string, unknown>, status: number, response: Response, ambiguous: boolean): ProviderRequestError {
  const code = typeof payload.error === "string" ? payload.error : `http_${status}`;
  const retryable = code === "ratelimited" || status === 429;
  return new ProviderRequestError(
    "slack",
    retryable ? "rate_limited" : code,
    status,
    retryAfterMs(response),
    ambiguous,
  );
}

export class SlackApiClient implements SlackNotifyPort {
  constructor(private readonly http: PluginContext["http"]) {}

  async verifyIdentity(config: SentryPilotConfig, token: string): Promise<void> {
    let response: Response;
    try {
      response = await this.http.fetch(`${config.slack.apiBaseUrl}/api/auth.test`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch {
      throw new ProviderRequestError("slack", "identity_network_failure", null, null, false);
    }
    const payload = await json(response, "slack");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ProviderRequestError("slack", "invalid_identity_response", response.status, null, false);
    }
    const body = payload as Record<string, unknown>;
    if (!response.ok || body.ok !== true) throw slackApiError(body, response.status, response, false);
    if (
      body.team_id !== config.slack.teamId
      || body.user_id !== config.slack.botUserId
      || body.bot_id !== config.slack.botId
    ) {
      throw new SentryWorkflowConfigError("wrong_slack_identity", "Slack auth.test identity does not match the approved configuration");
    }
    const scopes = parseSlackScopes(response);
    if (scopes.length !== 1 || scopes[0] !== "chat:write") {
      throw new SentryWorkflowConfigError("least_privilege_scope_required", "Slack token scopes are not exactly chat:write");
    }
  }

  async postSummary(input: {
    config: SentryPilotConfig;
    token: string;
    text: string;
  }): Promise<{ channelId: string; timestamp: string }> {
    let response: Response;
    try {
      response = await this.http.fetch(`${input.config.slack.apiBaseUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.token}`,
          accept: "application/json",
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: input.config.slack.channelId,
          text: input.text,
          unfurl_links: false,
          unfurl_media: false,
        }),
      });
    } catch {
      // The request may have reached Slack. Never blind-retry this outcome.
      throw new ProviderRequestError("slack", "ambiguous_network_failure", null, null, true);
    }
    const payload = await json(response, "slack");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ProviderRequestError("slack", "ambiguous_invalid_response", response.status, null, true);
    }
    const body = payload as Record<string, unknown>;
    if (!response.ok || body.ok !== true) {
      const unambiguous = response.status === 429 || body.error === "ratelimited";
      throw slackApiError(body, response.status, response, !unambiguous);
    }
    if (
      typeof body.channel !== "string"
      || body.channel !== input.config.slack.channelId
      || typeof body.ts !== "string"
    ) {
      throw new ProviderRequestError("slack", "ambiguous_destination_mismatch", response.status, null, true);
    }
    return { channelId: body.channel, timestamp: body.ts };
  }
}
