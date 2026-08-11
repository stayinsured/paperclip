import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, IssueDocument, IssueThreadInteraction } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import {
  assertRuntimeAuthorization,
  buildSlackSummary,
  configurationFingerprint,
  notificationIdentity,
  parseRemediationProposal,
  parseSentryPilotConfig,
  sanitizeSentryIssue,
  stableSentryIdentity,
  type RemediationProposal,
  type SanitizedSentryIssue,
  type SentryPilotConfig,
} from "../src/modules/sentry/contracts.js";
import { SentryApiClient, SlackApiClient } from "../src/modules/sentry/providers.js";
import type { SentryIssueState, SentryWorkflowRepository } from "../src/modules/sentry/repository.js";
import {
  PluginSentryControlPlane,
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

function rawConfig(input: { polling?: boolean; slack?: boolean; sentryScopes?: string[] } = {}): Record<string, unknown> {
  const polling = input.polling ?? false;
  const slack = input.slack ?? false;
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
        principalId: "sentry-pilot-reader",
        scopes: input.sentryScopes ?? ["org:read", "project:read", "event:read"],
        verifiedAt: "2026-08-07T00:00:00.000Z",
        expiresAt: "2026-08-08T00:00:00.000Z",
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
      configurationFingerprint: `sha256:${"0".repeat(64)}`,
      authorizedCapabilities: slack ? ["sentry.poll", "slack.notify"] : ["sentry.poll"],
    } : null,
  };
}

function activeConfig(slack = false): SentryPilotConfig {
  const first = parseSentryPilotConfig(rawConfig({ polling: true, slack }));
  const input = rawConfig({ polling: true, slack });
  (input.exactConfigurationApproval as Record<string, unknown>).configurationFingerprint = configurationFingerprint(first);
  return parseSentryPilotConfig(input);
}

function sourceIssue(): SanitizedSentryIssue {
  return {
    stableIssueId: "12345",
    shortId: "BFF-42",
    projectId: "4511354624540752",
    projectSlug: "bff",
    environment: "test",
    title: "Upstream timeout",
    providerUrl: "https://stay-ki.sentry.io/issues/12345",
    firstSeen: "2026-08-07T09:00:00.000Z",
    lastSeen: "2026-08-07T09:05:00.000Z",
    count: 3,
    release: "bff-2026.08.07",
    priority: "high",
    level: "error",
    category: "error",
    platform: "node",
    fingerprintSummary: "sha256:5994471abb01112a",
    regressed: false,
  };
}

function proposal(source = sourceIssue(), revision = "proposal-r2"): RemediationProposal {
  return {
    proposal_revision: revision,
    source: {
      sentry_issue_url: source.providerUrl,
      issue_key: source.shortId,
      project: source.projectSlug,
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

  it("keeps an unapproved configuration inert and rejects broad provider scopes", () => {
    const disabled = parseSentryPilotConfig(rawConfig());
    expect(disabled.pollingEnabled).toBe(false);
    expect(disabled.slackEnabled).toBe(false);
    expect(() => parseSentryPilotConfig(rawConfig({ polling: true, sentryScopes: ["org:read", "project:read", "event:read", "member:read"] })))
      .toThrow(/exactly event:read, org:read, project:read/i);
    expect(() => assertRuntimeAuthorization(activeConfig(), new Date("2026-08-08T00:00:00.000Z")))
      .toThrow(/expired/i);
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

  it("sanitizes provider data and uses stable, revision-bound identities", () => {
    const config = activeConfig(true);
    const sanitized = sanitizeSentryIssue(rawSentryIssue(), config);
    expect(sanitized.title).not.toContain("customer@example.com");
    expect(sanitized.title).not.toContain("secret-value");
    expect(Object.keys(sanitized).sort()).toEqual([
      "category", "count", "environment", "fingerprintSummary", "firstSeen", "lastSeen", "level", "platform",
      "priority", "projectId", "projectSlug", "providerUrl", "regressed", "release", "shortId", "stableIssueId", "title",
    ]);
    expect(stableSentryIdentity(config, sanitized.stableIssueId)).toContain(`${COMPANY_ID}:4511354603896832:4511354624540752:12345`);
    expect(notificationIdentity(config, sanitized.stableIssueId, "r1"))
      .not.toBe(notificationIdentity(config, sanitized.stableIssueId, "r2"));
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
