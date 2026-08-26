import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, IssueDocument, IssueThreadInteraction } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import {
  assertLiveSentryAuthorization,
  assertRuntimeAuthorization,
  buildSlackSummary,
  configurationFingerprint,
  notificationIdentity,
  parseRemediationProposal,
  parseSentryPilotConfig,
  sanitizeSentryIssue,
  stableSentryIdentity,
  type RemediationProposal,
  type FrozenSentrySnapshot,
  type SentryPilotConfig,
} from "../src/modules/sentry/contracts.js";
import { assertSentryGetTarget, SentryApiClient, SlackApiClient } from "../src/modules/sentry/providers.js";
import { PostgresSentryWorkflowRepository, type SentryIssueState, type SentryWorkflowRepository } from "../src/modules/sentry/repository.js";
import {
  PluginSentryControlPlane,
  assertSentryActivationAuthorized,
  SentryWorkflow,
  type SentryControlPlanePort,
} from "../src/modules/sentry/workflow.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REMEDIATION_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const TRIAGE_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const APPROVAL_ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const REVISION_ID = "55555555-5555-4555-8555-555555555555";
const INTERACTION_ID = "66666666-6666-4666-8666-666666666666";
const NARROW_SENTRY_SCOPES = ["event:read", "org:read", "project:read"];
const BROAD_SENTRY_SCOPES = [
  "alerts:read",
  "alerts:write",
  "event:admin",
  "event:read",
  "event:write",
  "member:admin",
  "member:invite",
  "member:read",
  "member:write",
  "org:admin",
  "org:integrations",
  "org:read",
  "org:write",
  "project:admin",
  "project:read",
  "project:releases",
  "project:write",
  "team:admin",
  "team:read",
  "team:write",
];

function rawConfig(input: {
  polling?: boolean;
  slack?: boolean;
  sentryScopes?: string[];
  broadException?: boolean;
} = {}): Record<string, unknown> {
  const polling = input.polling ?? false;
  const slack = input.slack ?? false;
  const scopes = [...(input.sentryScopes ?? NARROW_SENTRY_SCOPES)].sort();
  const broadException = input.broadException ?? scopes.length > NARROW_SENTRY_SCOPES.length;
  return {
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
    pollingEnabled: polling,
    slackEnabled: slack,
    policyVersion: "pilot-v1",
    batchSize: 100,
    maxPages: 100,
    sentry: {
      organizationSlug: "stay-ki",
      organizationId: "4511354603896832",
      projectSlug: "bff",
      projectId: "4511354624540752",
      environment: "test",
      tokenRef: polling ? { type: "secret_ref", secretId: "77777777-7777-4777-8777-777777777777" } : null,
      identityProof: polling ? {
        principalId: "4534765",
        scopes,
        verifiedAt: "2026-08-07T00:00:00.000Z",
        expiresAt: "2026-08-08T00:00:00.000Z",
      } : null,
      broadScopeException: polling && broadException ? {
        authorizationRevisionId: REVISION_ID,
        configurationFingerprint: "sha256:" + "0".repeat(64),
        principalId: "4534765",
        secretBinding: { type: "secret_ref", secretId: "77777777-7777-4777-8777-777777777777" },
        secretBindingPath: "sentry.sentry.tokenRef",
        organizationId: "4511354603896832",
        organizationSlug: "stay-ki",
        projectId: "4511354624540752",
        projectSlug: "bff",
        environment: "test",
        observedScopes: scopes,
      } : null,
    },
    slack: {
      teamId: "T08JDG82W2V",
      channelId: "C0B6C5VUUUV",
      appId: slack ? "A123456789" : null,
      botUserId: slack ? "U123456789" : null,
      botId: slack ? "B123456789" : null,
      tokenRef: slack ? { type: "secret_ref", secretId: "88888888-8888-4888-8888-888888888888" } : null,
      identityProof: slack ? {
        principalId: "slack-pilot-bot",
        scopes: ["chat:write"],
        verifiedAt: "2026-08-07T00:00:00.000Z",
        expiresAt: "2026-08-08T00:00:00.000Z",
      } : null,
    },
    remediationAssigneeAgentId: REMEDIATION_AGENT_ID,
    exactConfigurationApproval: polling ? {
      issueId: APPROVAL_ISSUE_ID,
      documentKey: "pilot-configuration",
      revisionId: REVISION_ID,
      revisionNumber: 1,
      interactionId: INTERACTION_ID,
      configurationFingerprint: "sha256:" + "0".repeat(64),
      authorizedCapabilities: slack ? ["sentry.poll", "slack.notify"] : ["sentry.poll"],
    } : null,
  };
}

function activeConfig(slack = false, scopes: string[] = NARROW_SENTRY_SCOPES): SentryPilotConfig {
  const input = rawConfig({ polling: true, slack, sentryScopes: scopes });
  const first = parseSentryPilotConfig(input);
  const fingerprint = configurationFingerprint(first);
  (input.exactConfigurationApproval as Record<string, unknown>).configurationFingerprint = fingerprint;
  const exception = (input.sentry as Record<string, unknown>).broadScopeException;
  if (exception) (exception as Record<string, unknown>).configurationFingerprint = fingerprint;
  return parseSentryPilotConfig(input);
}

function sourceIssue(config = activeConfig()): FrozenSentrySnapshot {
  return sanitizeSentryIssue(rawSentryIssue(), config, new Date("2026-08-07T09:06:00.000Z"));
}

function proposal(source = sourceIssue(), revision = "proposal-r2"): RemediationProposal {
  return {
    proposal_revision: revision,
    source: {
      stable_issue_id: source.stableIssueId,
      project_id: source.projectId,
      environment: source.environment,
    },
    data_handling: {
      allowlist_applied: true,
      excluded_sensitive_data: "unknown",
      raw_detail_copied: false,
    },
    severity: {
      level: "high",
      confidence: "medium",
      rationale: "Aggregate recurrence increased in the test environment.",
      urgency: "Human review within thirty minutes.",
    },
    affected_component: { observed_in: "bff", probable_owner: "unknown", ownership_confidence: "low" },
    evidence: [{ id: "E1", source_field: "aggregate recurrence", observation: "Three occurrences were observed." }],
    probable_root_cause: { hypothesis: "unknown", confidence: "unknown", evidence_ids: ["E1"], alternatives: [], missing_evidence: ["read-only trace boundary"] },
    customer_impact: { confirmed: [], unknown: ["Production impact is not established."], confidence: "unknown" },
    diagnostic_next_step: { read_only_check: "Inspect the linked issue aggregate.", expected_evidence: "A stable component boundary.", confidence_effect: "Raises or lowers ownership confidence." },
    fix_options: [],
    no_fix_boundary: { crossed: false, rationale: "Test-only evidence.", revisit_when: ["Production recurrence"] },
    approval_gate: {
      required: true,
      target_revision: revision,
      status: "not_requested",
      execution_allowed: false,
      note: "Paperclip board approval is required.",
    },
  };
}

function rawSentryIssue(): Record<string, unknown> {
  return {
    id: "12345",
    shortId: "BFF-42",
    project: { id: "4511354624540752", slug: "bff", platform: "node" },
    matchingEventEnvironment: "test",
    title: "Failure for customer@example.com authorization=secret-value",
    permalink: "https://stay-ki.sentry.io/issues/12345?project=4511354624540752#event",
    firstSeen: "2026-08-07T09:00:00Z",
    lastSeen: "2026-08-07T09:05:00Z",
    count: "3",
    priority: "high",
    level: "error",
    issueCategory: "error",
    platform: "node",
    status: "unresolved",
  };
}

describe("Sentry workflow contracts", () => {
  it("atomically replays plugin issue creation with the same company-scoped idempotency key", async () => {
    const harness = createTestHarness({ manifest });
    const first = await harness.ctx.issues.create({
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      title: "Sentry triage",
      originKind: "plugin:staydigital.stay-operational-workflows:sentry-triage",
      originId: "stable-origin",
      idempotencyKey: "sentry-triage:stable-origin",
    });
    const replay = await harness.ctx.issues.create({
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      title: "Sentry triage",
      originKind: "plugin:staydigital.stay-operational-workflows:sentry-triage",
      originId: "stable-origin",
      idempotencyKey: "sentry-triage:stable-origin",
    });
    const otherCompany = await harness.ctx.issues.create({
      companyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      projectId: PROJECT_ID,
      title: "Sentry triage",
      idempotencyKey: "sentry-triage:stable-origin",
    });
    expect(replay.id).toBe(first.id);
    expect(otherCompany.id).not.toBe(first.id);
  });

  it("keeps defaults inert and binds the explicit exception only for broad provider scopes", () => {
    const disabled = parseSentryPilotConfig(rawConfig());
    expect(disabled.pollingEnabled).toBe(false);
    expect(disabled.slackEnabled).toBe(false);
    expect(disabled.sentry.broadScopeException).toBeNull();

    const narrow = activeConfig();
    expect(narrow.sentry.broadScopeException).toBeNull();
    expect(() => assertRuntimeAuthorization(narrow, new Date("2026-08-07T12:00:00.000Z"))).not.toThrow();

    const broad = activeConfig(false, BROAD_SENTRY_SCOPES);
    expect(broad.sentry.broadScopeException?.observedScopes).toEqual(BROAD_SENTRY_SCOPES);
    expect(() => assertRuntimeAuthorization(broad, new Date("2026-08-07T12:00:00.000Z"))).not.toThrow();
    expect(() => parseSentryPilotConfig(rawConfig({
      polling: true,
      sentryScopes: BROAD_SENTRY_SCOPES,
      broadException: false,
    }))).toThrow(/revision-bound exception/i);
    expect(() => assertRuntimeAuthorization(activeConfig(), new Date("2026-08-08T00:00:00.000Z")))
      .toThrow(/expired/i);
    const missingFingerprint = rawConfig({ polling: true, sentryScopes: BROAD_SENTRY_SCOPES });
    delete (missingFingerprint.exactConfigurationApproval as Record<string, unknown>).configurationFingerprint;
    expect(() => parseSentryPilotConfig(missingFingerprint)).toThrow(/configurationFingerprint/i);
    const missingRevision = rawConfig({ polling: true, sentryScopes: BROAD_SENTRY_SCOPES });
    const exception = (missingRevision.sentry as Record<string, unknown>).broadScopeException as Record<string, unknown>;
    delete exception.authorizationRevisionId;
    expect(() => parseSentryPilotConfig(missingRevision)).toThrow(/authorizationRevisionId/i);
  });

  it("accepts absent or null Slack identities only while Slack notification is disabled", () => {
    for (const identityFields of [
      {},
      { teamId: null, channelId: null },
    ]) {
      const input = rawConfig();
      const slack = input.slack as Record<string, unknown>;
      delete slack.teamId;
      delete slack.channelId;
      Object.assign(slack, identityFields);

      const config = parseSentryPilotConfig(input);
      expect(config.slackEnabled).toBe(false);
      expect(config.slack.teamId).toBeNull();
      expect(config.slack.channelId).toBeNull();
    }

    for (const [field, value] of [
      ["teamId", ""],
      ["teamId", "TXXXXXXXX"],
      ["teamId", "workspace-name"],
      ["channelId", ""],
      ["channelId", "CXXXXXXXX"],
      ["channelId", "channel-name"],
    ] as const) {
      const input = rawConfig();
      (input.slack as Record<string, unknown>)[field] = value;
      expect(() => parseSentryPilotConfig(input)).toThrow(new RegExp(`slack\\.${field} is invalid`, "i"));
    }
  });

  it("requires exact syntactically valid Slack identities when notification is enabled", () => {
    const valid = parseSentryPilotConfig(rawConfig({ polling: true, slack: true }));
    expect(valid.slack.teamId).toBe("T08JDG82W2V");
    expect(valid.slack.channelId).toBe("C0B6C5VUUUV");

    for (const [field, value] of [
      ["teamId", undefined],
      ["teamId", null],
      ["teamId", "TXXXXXXXX"],
      ["teamId", "workspace-name"],
      ["channelId", undefined],
      ["channelId", null],
      ["channelId", "CXXXXXXXX"],
      ["channelId", "channel-name"],
    ] as const) {
      const input = rawConfig({ polling: true, slack: true });
      const slack = input.slack as Record<string, unknown>;
      if (value === undefined) delete slack[field];
      else slack[field] = value;

      expect(() => parseSentryPilotConfig(input)).toThrow(new RegExp(`slack\\.${field} is invalid`, "i"));
    }
  });

  it("persists only the frozen revision-2 allowlist and uses stable, revision-bound identities", () => {
    const config = activeConfig(true);
    const snapshot = sanitizeSentryIssue(rawSentryIssue(), config, new Date("2026-08-07T09:06:00.000Z"));
    expect(Object.keys(snapshot).sort()).toEqual([
      "aggregateEventCount", "correlationKey", "dedupeKey", "environment", "firstSeen", "lastSeen", "level",
      "organizationId", "policyVersion", "processedAt", "projectId", "providerOccurrenceTimestamp",
      "sanitizerVersion", "stableIssueId", "status",
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/customer@example\.com|secret-value|title|providerUrl|release|fingerprintSummary|raw/i);
    expect(Object.isFrozen(snapshot)).toBe(true);
    const replay = sanitizeSentryIssue(rawSentryIssue(), config, new Date("2026-08-07T09:07:00.000Z"));
    const increased = sanitizeSentryIssue({ ...rawSentryIssue(), count: "4" }, config, new Date("2026-08-07T09:07:00.000Z"));
    expect(replay.dedupeKey).toBe(snapshot.dedupeKey);
    expect(replay.correlationKey).toBe(snapshot.correlationKey);
    expect(increased.correlationKey).toBe(snapshot.correlationKey);
    expect(increased.dedupeKey).not.toBe(snapshot.dedupeKey);
    expect(stableSentryIdentity(config, snapshot.stableIssueId)).toContain(`${COMPANY_ID}:4511354603896832:4511354624540752:12345`);
    expect(notificationIdentity(config, snapshot.stableIssueId, "r1"))
      .not.toBe(notificationIdentity(config, snapshot.stableIssueId, "r2"));
  });

  it("accepts only the immutable non-executing proposal contract", () => {
    const source = sourceIssue();
    expect(parseRemediationProposal(JSON.stringify(proposal(source)), source).approval_gate.execution_allowed).toBe(false);
    const unsafe = proposal(source) as unknown as Record<string, unknown>;
    (unsafe.severity as Record<string, unknown>).rationale = "Contact customer@example.com";
    expect(() => parseRemediationProposal(JSON.stringify(unsafe), source)).toThrow(/prohibited/i);
  });

  it("requires the accepted configuration document to contain the exact fingerprint and capability", async () => {
    const config = activeConfig();
    const interaction = {
      id: INTERACTION_ID,
      kind: "request_confirmation",
      status: "accepted",
      result: { outcome: "accepted" },
      effectiveResolverPolicy: "board_only",
      payload: { target: { type: "issue_document", revisionId: REVISION_ID } },
    } as unknown as IssueThreadInteraction;
    const get = vi.fn().mockResolvedValue({
      latestRevisionId: REVISION_ID,
      latestRevisionNumber: 1,
      body: "This older policy authorizes zero provider calls.",
    });
    const control = new PluginSentryControlPlane({
      issues: { documents: { get }, listInteractions: vi.fn().mockResolvedValue([interaction]) },
    } as unknown as PluginContext);
    await expect(control.verifyExactConfigurationApproval(config)).rejects.toThrow(/does not contain.*fingerprint/i);

    get.mockResolvedValue({
      latestRevisionId: REVISION_ID,
      latestRevisionNumber: 1,
      body: JSON.stringify({ fingerprint: configurationFingerprint(config), capabilities: ["sentry.poll"] }),
    });
    await expect(control.verifyExactConfigurationApproval(config)).resolves.toBeUndefined();
  });
  it("binds the full fingerprint, principal, target, secret metadata, and complete 20-scope set", () => {
    const config = activeConfig(false, BROAD_SENTRY_SCOPES);
    expect(config.exactConfigurationApproval?.configurationFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(config.sentry.broadScopeException).toMatchObject({
      authorizationRevisionId: REVISION_ID,
      principalId: "4534765",
      secretBinding: config.sentry.tokenRef,
      secretBindingPath: "sentry.sentry.tokenRef",
      organizationId: "4511354603896832",
      organizationSlug: "stay-ki",
      projectId: "4511354624540752",
      projectSlug: "bff",
      environment: "test",
      observedScopes: BROAD_SENTRY_SCOPES,
    });
    const live = { principalId: "4534765", scopes: BROAD_SENTRY_SCOPES, organizationId: "4511354603896832", organizationSlug: "stay-ki", projectId: "4511354624540752", projectSlug: "bff", environment: "test" };
    expect(() => assertLiveSentryAuthorization(config, live)).not.toThrow();
    for (const mismatch of [
      { ...live, principalId: "wrong" },
      { ...live, scopes: [...BROAD_SENTRY_SCOPES, "unexpected:scope"] },
      { ...live, organizationId: "wrong" },
      { ...live, projectSlug: "wrong" },
      { ...live, environment: "production" },
    ]) expect(() => assertLiveSentryAuthorization(config, mismatch)).toThrow(/live Sentry (identity|scope|target)/i);

    const exception = config.sentry.broadScopeException!;
    for (const mutate of [
      (value: SentryPilotConfig) => { value.sentry.broadScopeException!.principalId = "changed"; },
      (value: SentryPilotConfig) => { value.sentry.broadScopeException!.authorizationRevisionId = "changed"; },
      (value: SentryPilotConfig) => { (value.sentry.broadScopeException as unknown as Record<string, unknown>).secretBindingPath = "changed.path"; },
      (value: SentryPilotConfig) => { (value.sentry.broadScopeException as unknown as Record<string, unknown>).environment = "changed"; },
      (value: SentryPilotConfig) => { value.sentry.broadScopeException!.observedScopes = [...exception.observedScopes, "unexpected:scope"].sort(); },
    ]) {
      const changed = structuredClone(config);
      mutate(changed);
      expect(configurationFingerprint(changed)).not.toBe(configurationFingerprint(config));
      expect(() => assertRuntimeAuthorization(changed, new Date("2026-08-07T12:00:00.000Z"))).toThrow();
    }

    const rebindFingerprint = (value: SentryPilotConfig): void => {
      const fingerprint = configurationFingerprint(value);
      value.exactConfigurationApproval!.configurationFingerprint = fingerprint;
      value.sentry.broadScopeException!.configurationFingerprint = fingerprint;
    };
    for (const mutate of [
      (value: SentryPilotConfig) => { value.sentry.broadScopeException!.authorizationRevisionId = "99999999-9999-4999-8999-999999999999"; },
      (value: SentryPilotConfig) => { value.sentry.broadScopeException!.principalId = "changed"; },
      (value: SentryPilotConfig) => { value.sentry.broadScopeException!.secretBinding = { type: "secret_ref", secretId: "99999999-9999-4999-8999-999999999999" }; },
      (value: SentryPilotConfig) => { (value.sentry.broadScopeException as unknown as Record<string, unknown>).secretBindingPath = "changed.path"; },
      (value: SentryPilotConfig) => { value.sentry.broadScopeException!.projectId = "999"; },
      (value: SentryPilotConfig) => { (value.sentry.broadScopeException as unknown as Record<string, unknown>).environment = "production"; },
      (value: SentryPilotConfig) => { value.sentry.broadScopeException!.observedScopes = [...exception.observedScopes, "unexpected:scope"].sort(); },
    ]) {
      const changed = structuredClone(config);
      mutate(changed);
      rebindFingerprint(changed);
      expect(() => assertRuntimeAuthorization(changed, new Date("2026-08-07T12:00:00.000Z")))
        .toThrow(/broad-scope exception/i);
    }
  });

  it("writes the frozen inventory unchanged at the repository boundary", async () => {
    const config = activeConfig();
    const snapshot = sourceIssue(config);
    const execute = vi.fn().mockResolvedValue({ rowCount: 1 });
    const query = vi.fn().mockResolvedValue([{
      id: "state-1", company_id: COMPANY_ID, project_id: PROJECT_ID, stable_sentry_issue_id: snapshot.stableIssueId,
      sanitized_snapshot: snapshot, triage_issue_id: null, resolved_at: null, resolved_count: null,
      current_proposal_revision_id: null, current_confirmation_id: null, remediation_issue_id: null,
      last_notified_revision_id: null, consecutive_slack_failures: 0,
    }]);
    const repository = new PostgresSentryWorkflowRepository({ namespace: "plugin_test", execute, query } as unknown as PluginContext["db"]);
    const state = await repository.upsertIssue(config, snapshot, new Date("2026-08-07T09:06:00.000Z"));
    const persisted = JSON.parse(execute.mock.calls[0][1][7] as string) as Record<string, unknown>;
    expect(persisted).toEqual(snapshot);
    expect(Object.keys(state.snapshot).sort()).toEqual(Object.keys(snapshot).sort());
    expect(JSON.stringify(persisted)).not.toMatch(/title|providerUrl|release|fingerprintSummary|raw/i);
  });

});

describe("Sentry and Slack provider boundaries", () => {
  it("paginates only within the configured Sentry endpoint and sends allowlisted query parameters", async () => {
    const config = activeConfig();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([rawSentryIssue()]), {
      status: 200,
      headers: {
        "content-type": "application/json",
        link: '<https://sentry.io/api/0/organizations/stay-ki/issues/?cursor=next:1>; rel="next"; results="true"',
      },
    }));
    const client = new SentryApiClient({ fetch } as unknown as PluginContext["http"]);
    const page = await client.listIssues({
      config,
      token: "not-persisted",
      start: "2026-08-07T08:55:00Z",
      end: "2026-08-07T09:05:00Z",
      cursor: null,
    });
    expect(page.nextCursor).toBe("next:1");
    const requested = new URL(fetch.mock.calls[0][0] as string);
    expect(requested.pathname).toBe("/api/0/organizations/stay-ki/issues/");
    expect(requested.searchParams.get("project")).toBe("4511354624540752");
    expect(requested.searchParams.get("environment")).toBe("test");
    expect(requested.searchParams.get("limit")).toBe("100");
    expect(JSON.stringify(page)).not.toContain("customer@example.com");
  });

  it("verifies the exact Slack bot and sends a notification-only payload", async () => {
    const config = activeConfig(true);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        team_id: config.slack.teamId,
        user_id: config.slack.botUserId,
        bot_id: config.slack.botId,
      }), { status: 200, headers: { "content-type": "application/json", "x-oauth-scopes": "chat:write" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, channel: config.slack.channelId, ts: "1.2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const slack = new SlackApiClient({ fetch } as unknown as PluginContext["http"]);
    await slack.verifyIdentity(config, "not-persisted");
    const text = buildSlackSummary({ source: sourceIssue(), proposal: proposal(), paperclipIssueUrl: "/STA/issues/STA-1" });

    await expect(slack.postSummary({ config, token: "not-persisted", text })).resolves.toEqual({
      channelId: config.slack.channelId,
      timestamp: "1.2",
    });
    const body = JSON.parse((fetch.mock.calls[1][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({ channel: config.slack.channelId, text, unfurl_links: false, unfurl_media: false });
    expect(body).not.toHaveProperty("blocks");
    expect(body).not.toHaveProperty("attachments");
  });
  it("reads live principal, scopes, organization, project, and environment through exact GET-only metadata targets", async () => {
    const config = activeConfig(false, BROAD_SENTRY_SCOPES);
    const payloads = [{ user: { id: "4534765" }, auth: { scopes: [...BROAD_SENTRY_SCOPES].reverse() } }, { id: "4511354603896832", slug: "stay-ki" }, { id: "4511354624540752", slug: "bff" }, { name: "test" }];
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(payloads.shift()), { status: 200, headers: { "content-type": "application/json", "x-sentry-scopes": "wrong:scope" } }));
    const client = new SentryApiClient({ fetch } as unknown as PluginContext["http"]);
    await expect(client.readAuthorization(config, "not-persisted")).resolves.toEqual({ principalId: "4534765", scopes: BROAD_SENTRY_SCOPES, organizationId: "4511354603896832", organizationSlug: "stay-ki", projectId: "4511354624540752", projectSlug: "bff", environment: "test" });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map((call) => (call[1] as RequestInit).method)).toEqual(["GET", "GET", "GET", "GET"]);
    expect(fetch.mock.calls.map((call) => new URL(call[0] as string).pathname)).toEqual(["/api/0/", "/api/0/organizations/stay-ki/", "/api/0/projects/stay-ki/bff/", "/api/0/projects/stay-ki/bff/environments/test/"]);
  });

  it("fails closed for non-GET, fallback, wrong-target, and unfiltered issue reads", () => {
    const config = activeConfig();
    const issues = new URL("https://sentry.io/api/0/organizations/stay-ki/issues/");
    issues.searchParams.set("project", config.sentry.projectId);
    issues.searchParams.set("environment", config.sentry.environment);
    issues.searchParams.set("start", "2026-08-07T08:55:00.000Z");
    issues.searchParams.set("end", "2026-08-07T09:05:00.000Z");
    issues.searchParams.set("query", "");
    issues.searchParams.set("sort", "date");
    issues.searchParams.set("limit", "100");
    for (const collapse of ["owners", "filtered", "unhandled"]) issues.searchParams.append("collapse", collapse);
    const valid = { config, method: "GET", url: issues.toString(), target: "issues" as const };
    expect(() => assertSentryGetTarget(valid)).not.toThrow();
    for (const target of [
      { ...valid, method: "POST" },
      { ...valid, url: valid.url.replace("https://sentry.io", "https://example.com") },
      { ...valid, url: valid.url.replace("/issues/", "/events/") },
      { ...valid, url: valid.url.replace(config.sentry.projectId, "999") },
      { ...valid, url: valid.url.replace("environment=test", "environment=production") },
      { ...valid, url: "https://sentry.io/api/0/organizations/stay-ki/issues/" },
      { ...valid, url: valid.url + "&project=999" },
      { ...valid, url: valid.url + "&cursor=unsafe%20cursor" },
    ]) expect(() => assertSentryGetTarget(target)).toThrow();
  });

  it("rechecks authorization immediately before every event page fetch", async () => {
    const config = activeConfig();
    const order: string[] = [];
    const fetch = vi.fn(async () => {
      order.push("fetch");
      const first = fetch.mock.calls.length === 1;
      return new Response(JSON.stringify(first ? [{ dateCreated: "2026-08-07T09:00:00.000Z" }] : []), {
        status: 200,
        headers: { "content-type": "application/json", link: first ? '<https://sentry.io/api/0/organizations/stay-ki/issues/12345/events/?cursor=next:1>; rel="next"; results="true"' : "" },
      });
    });
    const client = new SentryApiClient({ fetch } as unknown as PluginContext["http"]);
    const count = await client.countRecentOccurrences({
      config, token: "not-persisted", stableIssueId: "12345",
      start: "2026-08-07T08:55:00.000Z", end: "2026-08-07T09:05:00.000Z",
      beforeRead: async () => { order.push("authorize"); },
    });
    expect(count).toBe(1);
    expect(order).toEqual(["authorize", "fetch", "authorize", "fetch"]);
  });

});
  it("authorizes live metadata before activation persistence and stops mismatches first", async () => {
    const config = activeConfig(false, BROAD_SENTRY_SCOPES);
    const live = { principalId: "4534765", scopes: BROAD_SENTRY_SCOPES, organizationId: "4511354603896832", organizationSlug: "stay-ki", projectId: "4511354624540752", projectSlug: "bff", environment: "test" };
    const order: string[] = [];
    const activate = async (authorization = live) => {
      await assertSentryActivationAuthorized({
        config, now: new Date("2026-08-07T12:00:00.000Z"),
        verifyExactConfigurationApproval: async () => { order.push("document"); },
        resolveSecret: async () => { order.push("secret"); return "not-persisted"; },
        readAuthorization: async () => { order.push("live"); return authorization; },
      });
      order.push("persist");
    };
    await activate();
    expect(order).toEqual(["document", "secret", "live", "persist"]);
    order.length = 0;
    await expect(activate({ ...live, environment: "production" })).rejects.toThrow(/live Sentry .*target/i);
    expect(order).toEqual(["document", "secret", "live"]);
  });

  it("keeps polling and Slack disabled with zero provider writes", async () => {
    const config = parseSentryPilotConfig(rawConfig());
    const repository = { listConfigs: vi.fn().mockResolvedValue([]), listIssueStates: vi.fn().mockResolvedValue([]) } as unknown as SentryWorkflowRepository;
    const sentry = { readAuthorization: vi.fn(), listIssues: vi.fn(), countRecentOccurrences: vi.fn() };
    const slack = { verifyIdentity: vi.fn(), postSummary: vi.fn() };
    const resolveSecret = vi.fn();
    const workflow = new SentryWorkflow(repository, {} as never, sentry, slack, resolveSecret);
    const result = await workflow.reconcileCompany({ companyId: COMPANY_ID, audit: { actorType: "system", actorId: null, runId: null } });
    expect(config).toMatchObject({ pollingEnabled: false, slackEnabled: false });
    expect(result).toMatchObject({ configs: 0, pages: 0, notificationsSent: 0, exceptions: 0 });
    expect(result).not.toHaveProperty("externalWrites");
    expect(sentry.readAuthorization).not.toHaveBeenCalled();
    expect(sentry.listIssues).not.toHaveBeenCalled();
    expect(slack.postSummary).not.toHaveBeenCalled();
    expect(resolveSecret).not.toHaveBeenCalled();
    const externalWrites = slack.postSummary.mock.calls.length;
    expect(externalWrites).toBe(0);
  });

  it("rechecks current policy and live Sentry authorization before claim and every repeated poll page", async () => {
    const config = activeConfig();
    const run = { id: "poll-1", companyId: COMPANY_ID, projectId: PROJECT_ID, mode: "manual" as const, status: "running" as const, windowStart: "2026-08-07T08:55:00.000Z", windowEnd: "2026-08-07T09:05:00.000Z", nextCursor: null as string | null, pageCount: 0, observedCount: 0, leaseToken: "lease-1" };
    const order: string[] = [];
    const repository = {
      listConfigs: vi.fn().mockResolvedValueOnce([config]).mockResolvedValue([]),
      claimPollRun: vi.fn(async () => { order.push("claim"); return run; }),
      advancePollRun: vi.fn(async (_run, cursor) => { run.nextCursor = cursor; run.pageCount += 1; }),
      completePollRun: vi.fn(), listIssueStates: vi.fn().mockResolvedValue([]), createException: vi.fn(), failPollRun: vi.fn(),
    } as unknown as SentryWorkflowRepository;
    const controlPlane = { verifyExactConfigurationApproval: vi.fn(async () => { order.push("document"); }), resolveTriageAgent: vi.fn().mockResolvedValue(TRIAGE_AGENT_ID) } as unknown as SentryControlPlanePort;
    const live = { principalId: "4534765", scopes: NARROW_SENTRY_SCOPES, organizationId: "4511354603896832", organizationSlug: "stay-ki", projectId: "4511354624540752", projectSlug: "bff", environment: "test" };
    const pages = [{ issues: [], nextCursor: "next:1" }, { issues: [], nextCursor: null }];
    const sentry = { readAuthorization: vi.fn(async () => { order.push("live"); return live; }), listIssues: vi.fn(async () => { order.push("page"); return pages.shift()!; }), countRecentOccurrences: vi.fn() };
    const workflow = new SentryWorkflow(repository, controlPlane, sentry, {} as never, async () => { order.push("secret"); return "not-persisted"; }, () => new Date("2026-08-07T12:00:00.000Z"));
    const result = await workflow.reconcileCompany({ companyId: COMPANY_ID, mode: "manual", audit: { actorType: "system", actorId: null, runId: null } });
    expect(result).toMatchObject({ pages: 2, exceptions: 0 });
    expect(result).not.toHaveProperty("externalWrites");
    expect(order).toEqual(["document", "secret", "live", "claim", "document", "live", "page", "document", "live", "page"]);
  });

  it("stops live drift before claiming a poll or reading an issue page", async () => {
    const config = activeConfig();
    const claimPollRun = vi.fn();
    const listIssues = vi.fn();
    const createException = vi.fn();
    const repository = { listConfigs: vi.fn().mockResolvedValueOnce([config]).mockResolvedValue([]), listIssueStates: vi.fn().mockResolvedValue([]), claimPollRun, createException } as unknown as SentryWorkflowRepository;
    const controlPlane = { verifyExactConfigurationApproval: vi.fn(), resolveTriageAgent: vi.fn().mockResolvedValue(TRIAGE_AGENT_ID) } as unknown as SentryControlPlanePort;
    const sentry = { readAuthorization: vi.fn().mockResolvedValue({ principalId: "4534765", scopes: NARROW_SENTRY_SCOPES, organizationId: "4511354603896832", organizationSlug: "stay-ki", projectId: "4511354624540752", projectSlug: "bff", environment: "production" }), listIssues, countRecentOccurrences: vi.fn() };
    const workflow = new SentryWorkflow(repository, controlPlane, sentry, {} as never, async () => "not-persisted", () => new Date("2026-08-07T12:00:00.000Z"));
    const result = await workflow.reconcileCompany({ companyId: COMPANY_ID, audit: { actorType: "system", actorId: null, runId: null } });
    expect(result.exceptions).toBe(1);
    expect(claimPollRun).not.toHaveBeenCalled();
    expect(listIssues).not.toHaveBeenCalled();
    expect(createException).toHaveBeenCalledTimes(1);
  });


  it("reconciles a due Slack retry for an unchanged proposal revision", async () => {
    const config = activeConfig(true);
    const state: SentryIssueState = {
      id: "state-retry",
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      stableSentryIssueId: "12345",
      snapshot: sourceIssue(),
      triageIssueId: "triage-retry",
      resolvedAt: null,
      resolvedCount: null,
      currentProposalRevisionId: "revision-new",
      currentConfirmationId: "confirmation-new",
      remediationIssueId: null,
      lastNotifiedRevisionId: null,
      consecutiveSlackFailures: 1,
    };
    const triage = {
      id: "triage-retry",
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      identifier: "STA-2",
      status: "in_review",
    } as Issue;
    const document = {
      id: "document-retry",
      issueId: triage.id,
      key: "remediation-proposal",
      body: JSON.stringify(proposal()),
      latestRevisionId: "revision-new",
      latestRevisionNumber: 2,
    } as unknown as IssueDocument;
    const pending = {
      id: "confirmation-new",
      kind: "request_confirmation",
      status: "pending",
      effectiveResolverPolicy: "board_only",
      payload: { target: { type: "issue_document", revisionId: "revision-new" } },
    } as unknown as IssueThreadInteraction;
    const completeNotification = vi.fn(async () => { state.lastNotifiedRevisionId = "revision-new"; });
    const repository = {
      listIssueStates: vi.fn().mockResolvedValue([state]),
      listConfigs: vi.fn().mockResolvedValue([config]),
      claimNotification: vi.fn().mockResolvedValue({
        id: "notification-1",
        companyId: COMPANY_ID,
        issueStateId: state.id,
        proposalRevisionId: "revision-new",
        status: "retry_wait",
        attempt: 2,
        leaseToken: "lease-1",
      }),
      completeNotification,
      failNotification: vi.fn(),
      createException: vi.fn(),
    } as unknown as SentryWorkflowRepository;
    const controlPlane = {
      resolveTriageAgent: vi.fn().mockResolvedValue(TRIAGE_AGENT_ID),
      getIssue: vi.fn().mockResolvedValue(triage),
      getProposal: vi.fn().mockResolvedValue(document),
      listInteractions: vi.fn().mockResolvedValue([pending]),
      verifyExactConfigurationApproval: vi.fn(),
    } as unknown as SentryControlPlanePort;
    const slack = {
      verifyIdentity: vi.fn(),
      postSummary: vi.fn().mockResolvedValue({ channelId: config.slack.channelId, timestamp: "1.2" }),
    };
    const workflow = new SentryWorkflow(
      repository,
      controlPlane,
      {} as never,
      slack,
      async () => "resolved-only-at-call-time",
      () => new Date("2026-08-07T12:00:00.000Z"),
    );

    const result = await workflow.reconcileTriageIssue(COMPANY_ID, triage.id, { actorType: "system", actorId: null, runId: null });
    expect(result.notificationsSent).toBe(1);
    expect(repository.claimNotification).toHaveBeenCalledTimes(1);
    expect(slack.verifyIdentity).toHaveBeenCalledTimes(1);
    expect(slack.postSummary).toHaveBeenCalledTimes(1);
    expect(completeNotification).toHaveBeenCalledTimes(1);
  });

describe("revision-bound remediation", () => {
  it("supersedes an old acceptance and creates exactly one issue only after the current revision is accepted", async () => {
    const config = parseSentryPilotConfig(rawConfig());
    const state: SentryIssueState = {
      id: "state-1",
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      stableSentryIssueId: "12345",
      snapshot: sourceIssue(),
      triageIssueId: "triage-1",
      resolvedAt: null,
      resolvedCount: null,
      currentProposalRevisionId: "revision-old",
      currentConfirmationId: "confirmation-old",
      remediationIssueId: null,
      lastNotifiedRevisionId: null,
      consecutiveSlackFailures: 0,
    };
    const triage = {
      id: "triage-1",
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      identifier: "STA-1",
      status: "in_review",
    } as Issue;
    const document = {
      id: "document-1",
      issueId: triage.id,
      key: "remediation-proposal",
      body: JSON.stringify(proposal()),
      latestRevisionId: "revision-new",
      latestRevisionNumber: 2,
    } as unknown as IssueDocument;
    const pending = {
      id: "confirmation-new",
      kind: "request_confirmation",
      status: "pending",
      effectiveResolverPolicy: "board_only",
      payload: { target: { type: "issue_document", revisionId: "revision-new" } },
    } as unknown as IssueThreadInteraction;
    const accepted = {
      ...pending,
      status: "accepted",
      result: { outcome: "accepted" },
    } as unknown as IssueThreadInteraction;
    const createRemediationIssue = vi.fn().mockResolvedValue({ id: "remediation-1" } as Issue);
    const repository = {
      listIssueStates: vi.fn().mockResolvedValue([state]),
      listConfigs: vi.fn().mockResolvedValue([config]),
      bindProposal: vi.fn(async (_state, revisionId, confirmationId) => {
        state.currentProposalRevisionId = revisionId;
        state.currentConfirmationId = confirmationId;
      }),
      bindRemediation: vi.fn(async (_state, issueId) => { state.remediationIssueId = issueId; }),
      createException: vi.fn(),
    } as unknown as SentryWorkflowRepository;
    let currentInteractions = [{
      ...accepted,
      id: "confirmation-old",
      payload: { target: { type: "issue_document", revisionId: "revision-old" } },
    } as unknown as IssueThreadInteraction];
    const controlPlane = {
      resolveTriageAgent: vi.fn().mockResolvedValue(TRIAGE_AGENT_ID),
      getIssue: vi.fn().mockResolvedValue(triage),
      getProposal: vi.fn().mockResolvedValue(document),
      bindProposalConfirmation: vi.fn().mockResolvedValue(pending),
      listInteractions: vi.fn(async () => currentInteractions),
      findRemediationIssue: vi.fn().mockResolvedValue(null),
      createRemediationIssue,
    } as unknown as SentryControlPlanePort;
    const workflow = new SentryWorkflow(
      repository,
      controlPlane,
      {} as never,
      {} as never,
      async () => "unused",
    );

    const superseded = await workflow.reconcileTriageIssue(COMPANY_ID, triage.id, { actorType: "system", actorId: null, runId: null });
    expect(superseded.proposalsBound).toBe(1);
    expect(createRemediationIssue).not.toHaveBeenCalled();

    currentInteractions = [accepted];
    const authorized = await workflow.reconcileTriageIssue(COMPANY_ID, triage.id, { actorType: "system", actorId: null, runId: null });
    expect(authorized.remediationCreated).toBe(1);
    expect(createRemediationIssue).toHaveBeenCalledTimes(1);

    await workflow.reconcileTriageIssue(COMPANY_ID, triage.id, { actorType: "system", actorId: null, runId: null });
    expect(createRemediationIssue).toHaveBeenCalledTimes(1);
  });
});
