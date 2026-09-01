import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({
  insert: mockTxInsert,
}));
const mockDbSelectOrderBy = vi.hoisted(() => vi.fn(async () => []));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  orderBy: mockDbSelectOrderBy,
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
}));
const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));
const mockExternalObjectService = vi.hoisted(() => ({
  syncCommentSafely: vi.fn(async () => undefined),
  syncIssueSafely: vi.fn(async () => undefined),
}));
const mockObserveCrossIssueInfluence = vi.hoisted(() => vi.fn());
const mockCrossIssueInfluenceLimitError = vi.hoisted(() => vi.fn());
const mockCrossIssueInfluenceRunContextError = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => mockFeedbackService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeatService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => mockRoutineService,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  feedbackService: () => mockFeedbackService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => mockIssueRecoveryActionService,
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  issueTreeControlService: () => mockIssueTreeControlService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

vi.mock("../services/external-objects.js", () => ({
  externalObjectService: () => mockExternalObjectService,
}));

vi.mock("../services/cross-issue-influence-limit.js", () => ({
  observeCrossIssueInfluence: mockObserveCrossIssueInfluence,
  crossIssueInfluenceLimitError: mockCrossIssueInfluenceLimitError,
  crossIssueInfluenceRunContextError: mockCrossIssueInfluenceRunContextError,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express, actor?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "in_progress" as const,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Terminal comment finalizer",
  };
}

function runScopedAgentActor() {
  return {
    type: "agent",
    agentId: "22222222-2222-4222-8222-222222222222",
    companyId: "company-1",
    source: "agent_key",
    runId: "77777777-7777-4777-8777-777777777777",
  };
}

// Replay case 1: full continuation-summary scaffold leaked as the comment body.
const FULL_SCAFFOLD_REPLAY = [
  "# Continuation Summary",
  "",
  "## Recent Concrete Actions",
  "",
  "- Run `dad75505-9f51-4dfa-9c22-fc7d95042025` finished with status `succeeded`.",
  "- Let me digest the wake payload.",
  "- I'm the CTO agent (805da696).",
  "- Recovery cause: stranded_assigned_issue.",
  "",
  "## Commands Run",
  "",
  "- Heartbeat run `dad75505` invoked adapter `claude_local`.",
  "",
  "## Files / Routes Touched",
  "",
  "- `packages/adapter-utils`",
  "",
  "## Next Action",
  "",
  "- Resume implementation from the acceptance criteria.",
].join("\n");

// Replay case 2: authored summary with a wake-digest block leaked mid-comment.
// The trailing authored block carries its own (non-scaffold) heading; unheaded
// content after a leaked heading belongs to that section.
const PARTIAL_LEAK_REPLAY = [
  "Implemented the structured terminal-comment finalizer; focused tests pass.",
  "",
  "## Recent Concrete Actions",
  "",
  "- Let me digest the wake payload.",
  "- I'm the CTO agent (805da696).",
  "",
  "## Commands Run",
  "",
  "- Heartbeat run `dad75505` invoked adapter `claude_local`.",
  "- Fallback order: (1) send back to the assignee.",
  "",
  "## Remaining risk",
  "",
  "sanitizer only removes generated scaffold headings.",
].join("\n");

describe.sequential("issue comment terminal finalizer routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.getCurrentScheduledRetry.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockExecutionWorkspaceService.getById.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockLogActivity.mockReset();
    mockFeedbackService.listIssueVotesForUser.mockReset();
    mockFeedbackService.saveIssueVote.mockReset();
    mockInstanceSettingsService.get.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockRoutineService.syncRunStatusForIssue.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockReset();
    mockIssueTreeControlService.getActivePauseHoldGate.mockReset();
    mockExternalObjectService.syncCommentSafely.mockReset();
    mockExternalObjectService.syncIssueSafely.mockReset();
    mockObserveCrossIssueInfluence.mockReset();
    mockCrossIssueInfluenceLimitError.mockReset();
    mockCrossIssueInfluenceRunContextError.mockReset();
    mockTxInsertValues.mockReset();
    mockTxInsert.mockReset();
    mockDbSelect.mockReset();
    mockDbSelectFrom.mockReset();
    mockDbSelectWhere.mockReset();
    mockDbSelectOrderBy.mockReset();
    mockDb.transaction.mockReset();
    mockTxInsertValues.mockResolvedValue(undefined);
    mockTxInsert.mockImplementation(() => ({ values: mockTxInsertValues }));
    mockDbSelectOrderBy.mockResolvedValue([]);
    mockDbSelectWhere.mockImplementation(() => ({
      orderBy: mockDbSelectOrderBy,
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(onFulfilled, onRejected),
    }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockExternalObjectService.syncCommentSafely.mockResolvedValue(undefined);
    mockExternalObjectService.syncIssueSafely.mockResolvedValue(undefined);
    mockObserveCrossIssueInfluence.mockResolvedValue({
      allowed: true,
      mode: "log_only",
      count: 1,
      cap: 20,
      enforceAt: "2026-08-11T00:00:00.000Z",
    });
    mockCrossIssueInfluenceLimitError.mockImplementation((decision: { count: number; cap: number }) => ({
      error: `Cross-issue influence cap exceeded: this run is limited to ${decision.cap} cross-issue comments or updates`,
      details: { code: "cross_issue_influence_cap_exceeded", count: decision.count, cap: decision.cap },
    }));
    mockCrossIssueInfluenceRunContextError.mockImplementation(() => new Error(
      "Agent issue comments and updates require a valid heartbeat run",
    ));
    mockLogActivity.mockResolvedValue(undefined);
    mockFeedbackService.listIssueVotesForUser.mockResolvedValue([]);
    mockFeedbackService.saveIssueVote.mockResolvedValue({
      vote: null,
      consentEnabledNow: false,
      sharingEnabled: false,
    });
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueTreeControlService.getActivePauseHoldGate.mockResolvedValue(null);
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.update.mockResolvedValue(makeIssue());
    mockIssueService.addComment.mockImplementation(async (_issueId: string, body: string) => ({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: "22222222-2222-4222-8222-222222222222",
      authorUserId: null,
    }));
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "11111111-1111-4111-8111-111111111111",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => {
      const allowed = input.action !== "tasks:manage_active_checkouts";
      return {
        allowed,
        action: input.action,
        reason: input.action === "issue:comment" ? "allow_visible_issue_write" : "allow_explicit_grant",
        explanation: allowed ? "Allowed by the shared visible-issue write rule." : "Missing active checkout override.",
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
  });

  it("replay 1: renders only the structured terminal summary for a fully leaked scaffold", async () => {
    const res = await request(await installActor(createApp(), runScopedAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: FULL_SCAFFOLD_REPLAY,
        terminal: {
          status: "done — STA-2904 finalizer implemented",
          evidence: ["two leaked-transcript replay cases render only terminal summaries"],
          nextOwner: "CTO for independent review",
          disposition: "PR opened into dev",
        },
      });

    expect(res.status).toBe(201);
    const storedBody = mockIssueService.addComment.mock.calls[0][1];
    expect(storedBody).toContain("**Status:** done — STA-2904 finalizer implemented");
    expect(storedBody).toContain("**Next owner:** CTO for independent review");
    expect(storedBody).not.toContain("Continuation Summary");
    expect(storedBody).not.toContain("Recent Concrete Actions");
    expect(storedBody).not.toContain("Let me digest");
    expect(storedBody).not.toContain("I'm the CTO agent");
    expect(storedBody).not.toContain("Heartbeat run");
  });

  it("replay 2: strips leaked sections from a run comment without a structured draft", async () => {
    const res = await request(await installActor(createApp(), runScopedAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: PARTIAL_LEAK_REPLAY });

    expect(res.status).toBe(201);
    const storedBody = mockIssueService.addComment.mock.calls[0][1];
    expect(storedBody).toContain("Implemented the structured terminal-comment finalizer; focused tests pass.");
    expect(storedBody).toContain("## Remaining risk");
    expect(storedBody).toContain("sanitizer only removes generated scaffold headings.");
    expect(storedBody).not.toContain("## Recent Concrete Actions");
    expect(storedBody).not.toContain("Let me digest");
    expect(storedBody).not.toContain("Heartbeat run");
    expect(storedBody).not.toContain("Fallback order");
  });

  it("stores ordinary agent markdown unchanged", async () => {
    const ordinary = [
      "## Summary",
      "",
      "Finalizer shipped.",
      "",
      "- structured fields render deterministically",
      "- leaked scaffold headings are stripped",
      "",
      "## Next steps",
      "Nothing on the known-heading list.",
    ].join("\n");
    const res = await request(await installActor(createApp(), runScopedAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: ordinary });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment.mock.calls[0][1]).toBe(ordinary);
  });

  it("rejects a run comment that is only transcript scaffolding", async () => {
    const res = await request(await installActor(createApp(), runScopedAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: FULL_SCAFFOLD_REPLAY });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("progress-transcript scaffolding");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("leaves comments outside a run untouched", async () => {
    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: FULL_SCAFFOLD_REPLAY });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment.mock.calls[0][1]).toBe(FULL_SCAFFOLD_REPLAY);
  });

  it("rejects structured terminal fields outside a run", async () => {
    const res = await request(await installActor(createApp()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Terminal summary.", terminal: { status: "done" } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only run-scoped adapter comments may submit structured terminal fields");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("validates the structured terminal draft shape", async () => {
    const res = await request(await installActor(createApp(), runScopedAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Terminal summary.", terminal: { evidence: ["missing status"] } });

    expect(res.status).toBe(400);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });
});
