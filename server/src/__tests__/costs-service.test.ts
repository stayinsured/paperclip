import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createDb,
  companies,
  agents,
  activityLog,
  costEvents,
  financeEvents,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import { costService } from "../services/costs.ts";
import { financeService } from "../services/finance.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function makeDb(overrides: Record<string, unknown> = {}) {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue([]),
  };

  const thenableChain = Object.assign(Promise.resolve([]), selectChain);

  return {
    select: vi.fn().mockReturnValue(thenableChain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    ...overrides,
  };
}

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  cancelBudgetScopeWork: vi.fn().mockResolvedValue(undefined),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFetchAllQuotaWindows = vi.hoisted(() => vi.fn());
const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ spendCents: 0 }),
  tokenTelemetryBaseline: vi.fn().mockResolvedValue({
    companyId: "company-1",
    window: { consecutiveUtcDays: 14 },
    coverage: { exactModelThresholdMet: true },
    dailyRollups: [],
    completedIssueRollups: [],
    cohortBaselines: [],
  }),
  completedIssueTelemetry: vi.fn().mockResolvedValue({
    companyId: "company-1",
    completedIssues: [],
  }),
  sessionReuseEvaluation: vi.fn().mockResolvedValue({
    verdict: "CONDITIONAL",
    decision: { action: "keep_disabled", rollbackRequired: false },
  }),
  byAgent: vi.fn().mockResolvedValue([]),
  byAgentModel: vi.fn().mockResolvedValue([]),
  byProvider: vi.fn().mockResolvedValue([]),
  byBiller: vi.fn().mockResolvedValue([]),
  issueTreeSummary: vi.fn().mockResolvedValue({
    issueId: "issue-1",
    issueCount: 1,
    includeDescendants: true,
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    runCount: 0,
    runtimeMs: 0,
  }),
  windowSpend: vi.fn().mockResolvedValue([]),
  byProject: vi.fn().mockResolvedValue([]),
}));
const mockFinanceService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ debitCents: 0, creditCents: 0, netCents: 0, estimatedDebitCents: 0, eventCount: 0 }),
  byBiller: vi.fn().mockResolvedValue([]),
  byKind: vi.fn().mockResolvedValue([]),
  list: vi.fn().mockResolvedValue([]),
}));
const mockBudgetService = vi.hoisted(() => ({
  overview: vi.fn().mockResolvedValue({
    companyId: "company-1",
    policies: [],
    activeIncidents: [],
    pausedAgentCount: 0,
    pausedProjectCount: 0,
    pendingApprovalCount: 0,
  }),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    budgetService: () => mockBudgetService,
    costService: () => mockCostService,
    financeService: () => mockFinanceService,
    companyService: () => mockCompanyService,
    agentService: () => mockAgentService,
    issueService: () => mockIssueService,
    heartbeatService: () => mockHeartbeatService,
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/quota-windows.js", () => ({
    fetchAllQuotaWindows: mockFetchAllQuotaWindows,
  }));
}

async function createApp() {
  const [{ costRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/costs.js")>("../routes/costs.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
    next();
  });
  app.use("/api", costRoutes(makeDb() as any));
  app.use(errorHandler);
  return app;
}

async function createAppWithActor(actor: any) {
  const [{ costRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/costs.js")>("../routes/costs.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", costRoutes(makeDb() as any));
  app.use(errorHandler);
  return app;
}

async function loadCostParsers() {
  const {
    parseCostDateRange,
    parseCostLimit,
    parseTokenTelemetryBaselineRange,
  } = await import("../routes/costs.js");
  return { parseCostDateRange, parseCostLimit, parseTokenTelemetryBaselineRange };
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/quota-windows.js");
  vi.doUnmock("../routes/costs.js");
  vi.doUnmock("../middleware/index.js");
  registerModuleMocks();
  vi.clearAllMocks();
  mockAccessService.decide.mockReset();
  mockAccessService.decide.mockResolvedValue({
    allowed: true,
    action: "company_scope:read",
    reason: "allow_test",
    explanation: "Allowed by test mock.",
  });
  mockCompanyService.update.mockResolvedValue({
    id: "company-1",
    name: "Paperclip",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockAgentService.getById.mockResolvedValue({
    id: "agent-1",
    companyId: "company-1",
    name: "Budget Agent",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockAgentService.update.mockResolvedValue({
    id: "agent-1",
    companyId: "company-1",
    name: "Budget Agent",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockIssueService.getById.mockResolvedValue({
    id: "issue-1",
    companyId: "company-1",
    identifier: "PC1A2-1",
  });
  mockIssueService.getByIdentifier.mockResolvedValue({
    id: "issue-1",
    companyId: "company-1",
    identifier: "PC1A2-1",
  });
  mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
});

describe("cost routes", () => {
  it("accepts valid ISO date strings", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(parseCostDateRange({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T23:59:59.999Z",
    })).toEqual({
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-31T23:59:59.999Z"),
    });
  });

  it("returns 400 for an invalid 'from' date string", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(() => parseCostDateRange({ from: "not-a-date" })).toThrow(/invalid 'from' date/i);
  });

  it("returns 400 for an invalid 'to' date string", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(() => parseCostDateRange({ to: "banana" })).toThrow(/invalid 'to' date/i);
  });

  it("returns finance summary rows for valid requests", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/finance-summary")
      .query({ from: "2026-02-01T00:00:00.000Z", to: "2026-02-28T23:59:59.999Z" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      estimatedDebitCents: 0,
      eventCount: 0,
    });
  });

  it("uses a complete 14-day UTC window for the default token telemetry baseline", async () => {
    const { parseTokenTelemetryBaselineRange } = await loadCostParsers();
    expect(parseTokenTelemetryBaselineRange({}, new Date("2026-08-21T18:30:00.000Z"))).toEqual({
      from: new Date("2026-08-07T00:00:00.000Z"),
      toExclusive: new Date("2026-08-21T00:00:00.000Z"),
    });
  });

  it("returns the token telemetry baseline through the company-scoped route", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/token-telemetry-baseline")
      .query({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(mockCostService.tokenTelemetryBaseline).toHaveBeenCalledWith("company-1", {
      from: new Date("2026-08-01T00:00:00.000Z"),
      toExclusive: new Date("2026-08-15T00:00:00.000Z"),
    });
    expect(res.body.coverage.exactModelThresholdMet).toBe(true);
  });

  it("returns completed-issue telemetry through the requested company scope", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/completed-issue-telemetry")
      .query({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(mockCostService.completedIssueTelemetry).toHaveBeenCalledWith("company-1", {
      from: new Date("2026-08-01T00:00:00.000Z"),
      toExclusive: new Date("2026-08-15T00:00:00.000Z"),
    });
  });

  it("runs the authoritative evaluator through the requested company scope", async () => {
    const app = await createApp();
    const body = {
      from: "2026-08-01T00:00:00.000Z",
      toExclusive: "2026-08-15T00:00:00.000Z",
      pilotIssueIds: [randomUUID()],
      controlIssueIds: [randomUUID()],
    };
    const res = await request(app)
      .post("/api/companies/company-1/costs/session-reuse-evaluation")
      .send(body);

    expect(res.status).toBe(200);
    expect(mockCostService.sessionReuseEvaluation).toHaveBeenCalledWith("company-1", body);
    expect(res.body).toMatchObject({ verdict: "CONDITIONAL", decision: { action: "keep_disabled" } });
  });

  it("denies cross-company telemetry reads before invoking the evaluator", async () => {
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });
    const res = await request(app)
      .post("/api/companies/company-1/costs/session-reuse-evaluation")
      .send({
        from: "2026-08-01T00:00:00.000Z",
        toExclusive: "2026-08-15T00:00:00.000Z",
        pilotIssueIds: [randomUUID()],
        controlIssueIds: [randomUUID()],
      });

    expect(res.status).toBe(403);
    expect(mockCostService.sessionReuseEvaluation).not.toHaveBeenCalled();
  });

  it("returns issue subtree cost summaries for issue refs", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/issues/pc1a2-1/cost-summary");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PC1A2-1");
    expect(mockCostService.issueTreeSummary).toHaveBeenCalledWith("company-1", "issue-1", {
      excludeRoot: false,
    });
    expect(res.body).toEqual({
      issueId: "issue-1",
      issueCount: 1,
      includeDescendants: true,
      costCents: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      runCount: 0,
      runtimeMs: 0,
    });
  });

  it("returns 400 for invalid finance event list limits", async () => {
    const { parseCostLimit } = await loadCostParsers();
    expect(() => parseCostLimit({ limit: "0" })).toThrow(/invalid 'limit'/i);
  });

  it("accepts valid finance event list limits", async () => {
    const { parseCostLimit } = await loadCostParsers();
    expect(parseCostLimit({ limit: "25" })).toBe(25);
  });

  it("rejects company budget updates for board users outside the company", async () => {
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/companies/company-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates for board users outside the agent company", async () => {
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates from the target agent without changing the budget policy", async () => {
    const app = await createAppWithActor({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board access required" });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates from another same-company agent without changing the budget policy", async () => {
    const app = await createAppWithActor({
      type: "agent",
      agentId: "agent-2",
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board access required" });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("allows authorized board users to update an agent budget and budget policy", async () => {
    mockAgentService.update.mockResolvedValueOnce({
      id: "agent-1",
      companyId: "company-1",
      name: "Budget Agent",
      budgetMonthlyCents: 2500,
      spentMonthlyCents: 0,
    });
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith("agent-1", { budgetMonthlyCents: 2500 });
    expect(mockBudgetService.upsertPolicy).toHaveBeenCalledWith(
      "company-1",
      {
        scopeType: "agent",
        scopeId: "agent-1",
        amount: 2500,
        windowKind: "calendar_month_utc",
      },
      "board-user",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "user",
        actorId: "board-user",
        agentId: null,
        action: "agent.budget_updated",
        entityType: "agent",
        entityId: "agent-1",
        details: { budgetMonthlyCents: 2500 },
      }),
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cost and finance aggregate overflow handling", () => {
  let db!: ReturnType<typeof createDb>;
  let costs!: ReturnType<typeof costService>;
  let finance!: ReturnType<typeof financeService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-costs-service-");
    db = createDb(tempDb.connectionString);
    costs = costService(db);
    finance = financeService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists unpriced token usage without inflating monthly spend", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CLI Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const event = await costs.createEvent(companyId, {
      agentId,
      provider: "openai",
      biller: "chatgpt",
      billingType: "subscription_included",
      costStatus: "unpriced",
      model: "gpt-5.6-terra",
      inputTokens: 2_732_577,
      cachedInputTokens: 2_632_998,
      outputTokens: 32_644,
      costCents: 0,
      occurredAt: new Date("2026-07-13T14:22:54.000Z"),
    });

    expect(event.costStatus).toBe("unpriced");
    expect(event.inputTokens).toBe(2_732_577);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent?.spentMonthlyCents).toBe(0);
  });

  it("builds attributed token telemetry from ledger, run, issue, and project rows", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Telemetry Agent",
      role: "devops",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.6-terra" },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Telemetry Project",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      assigneeAgentId: agentId,
      title: "Measured delivery",
      status: "done",
      priority: "high",
      issueNumber: 1,
      identifier: "TLM-1",
      completedAt: new Date("2026-08-03T00:00:00.000Z"),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      startedAt: new Date("2026-08-02T11:59:00.000Z"),
      finishedAt: new Date("2026-08-02T12:00:00.000Z"),
      contextSnapshot: { issueId, wakeReason: "issue_commented" },
      usageJson: {
        model: "gpt-5.6-sol",
        taskSessionReused: false,
        freshSession: true,
      },
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      heartbeatRunId: runId,
      provider: "openai",
      biller: "openai",
      billingType: "metered_api",
      model: "unknown",
      inputTokens: 40,
      cachedInputTokens: 50,
      outputTokens: 10,
      costCents: 25,
      occurredAt: new Date("2026-08-02T12:00:00.000Z"),
    });

    const report = await costs.tokenTelemetryBaseline(companyId, {
      from: new Date("2026-08-01T00:00:00.000Z"),
      toExclusive: new Date("2026-08-15T00:00:00.000Z"),
    });

    expect(report.coverage).toMatchObject({
      exactModelPaidSpendPercent: 100,
      tokenBearingRunCount: 1,
      issueAttributedRunCount: 1,
      tokenBearingRunsAccountedPercent: 100,
    });
    expect(report.dailyRollups[0]).toMatchObject({
      model: "gpt-5.6-sol",
      modelSource: "run_usage",
      wakeReason: "issue_commented",
      taskSessionReused: false,
      resetCause: "no_prior_session",
      projectId,
      metrics: {
        uncachedInputTokens: 40,
        cachedInputTokens: 50,
        outputTokens: 10,
        processedTokens: 100,
        paidCostCents: 25,
        meteredProcessedTokens: 100,
        meteredCostCents: 25,
        subscriptionProcessedTokens: 0,
        subscriptionCostCents: 0,
      },
    });
    expect(report.completedIssueRollups[0]).toMatchObject({
      issueIdentifier: "TLM-1",
      projectId,
      assigneeAgentId: agentId,
      runCount: 1,
      runtimeMs: 60_000,
    });
  });

  it("hydrates cohort outcomes from persisted completion and reopen lifecycle evidence", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID();
    const shadowIssueId = randomUUID(), controlIssueId = randomUUID(), shadowRunId = randomUUID(), controlRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Routing Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(projects).values({ id: projectId, companyId, name: "Routing Project", status: "active" });
    await db.insert(issues).values([
      { id: shadowIssueId, companyId, projectId, assigneeAgentId: agentId, title: "Shadow", status: "done", priority: "high", issueNumber: 11, identifier: "RTE-11", completedAt: new Date("2026-08-03T00:00:00.000Z") },
      { id: controlIssueId, companyId, projectId, assigneeAgentId: agentId, title: "Control", status: "done", priority: "high", issueNumber: 12, identifier: "RTE-12", completedAt: new Date("2026-08-03T00:00:00.000Z") },
    ]);
    const decision = { mode: "shadow", taskClass: "read_only_check", proposedLane: "economy", appliedLane: "strongest", decisionReason: "routine_candidate", escalationReason: null, profileFallbackReason: null };
    await db.insert(heartbeatRuns).values([
      { id: shadowRunId, companyId, agentId, status: "succeeded", startedAt: new Date("2026-08-02T11:59:00.000Z"), finishedAt: new Date("2026-08-02T12:00:00.000Z"), contextSnapshot: { issueId: shadowIssueId }, resultJson: { paperclipRoutingDecision: decision }, usageJson: { model: "gpt-5" } },
      { id: controlRunId, companyId, agentId, status: "succeeded", startedAt: new Date("2026-08-02T12:59:00.000Z"), finishedAt: new Date("2026-08-02T13:00:00.000Z"), contextSnapshot: { issueId: controlIssueId }, usageJson: { model: "gpt-5" } },
    ]);
    await db.insert(costEvents).values([
      { companyId, agentId, heartbeatRunId: shadowRunId, provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-5", inputTokens: 40, cachedInputTokens: 50, outputTokens: 10, costCents: 25, occurredAt: new Date("2026-08-02T12:00:00.000Z") },
      { companyId, agentId, heartbeatRunId: controlRunId, provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-5", inputTokens: 40, cachedInputTokens: 50, outputTokens: 10, costCents: 25, occurredAt: new Date("2026-08-02T13:00:00.000Z") },
    ]);
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: "board", action: "issue.updated", entityType: "issue", entityId: shadowIssueId, details: { reopened: true, reopenedFrom: "done" } });
    const report = await costs.shadowRoutingCohort(companyId, { from: new Date("2026-08-01T00:00:00.000Z"), toExclusive: new Date("2026-08-15T00:00:00.000Z") });
    expect(report.outcomes.firstPassAcceptance.shadow).toEqual({ count: 0, total: 1, rate: 0 });
    expect(report.outcomes.firstPassAcceptance.control).toEqual({ count: 1, total: 1, rate: 1 });
    expect(report.outcomes.reopen.shadow).toEqual({ count: 1, total: 1, rate: 1 });
    expect(report.outcomes.reopen.control).toEqual({ count: 0, total: 1, rate: 0 });
    expect(report.outcomes.verdict).toBe("block");
  });

  it("keeps completed-issue telemetry company-scoped across persisted sources", async () => {
    const targetCompanyId = randomUUID();
    const foreignCompanyId = randomUUID();
    const targetAgentId = randomUUID();
    const foreignAgentId = randomUUID();
    const targetIssueId = randomUUID();
    const foreignIssueId = randomUUID();
    const targetRunId = randomUUID();
    const foreignRunId = randomUUID();
    await db.insert(companies).values([
      { id: targetCompanyId, name: "Target", issuePrefix: `A${targetCompanyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false },
      { id: foreignCompanyId, name: "Foreign", issuePrefix: `B${foreignCompanyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values([
      { id: targetAgentId, companyId: targetCompanyId, name: "Target Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: foreignAgentId, companyId: foreignCompanyId, name: "Foreign Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values([
      { id: targetIssueId, companyId: targetCompanyId, assigneeAgentId: targetAgentId, title: "Target", status: "done", priority: "high", issueNumber: 1, identifier: "TGT-1", createdAt: new Date("2026-08-01T00:00:00.000Z"), completedAt: new Date("2026-08-02T00:00:00.000Z") },
      { id: foreignIssueId, companyId: foreignCompanyId, assigneeAgentId: foreignAgentId, title: "Foreign", status: "done", priority: "high", issueNumber: 1, identifier: "FRN-1", createdAt: new Date("2026-08-01T00:00:00.000Z"), completedAt: new Date("2026-08-02T00:00:00.000Z") },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: targetRunId, companyId: targetCompanyId, agentId: targetAgentId, status: "succeeded", sessionIdBefore: "target-session", contextSnapshot: { issueId: targetIssueId }, usageJson: { taskSessionReused: true, configFreshness: { session: { nextFingerprint: "target-security" } } } },
      { id: foreignRunId, companyId: foreignCompanyId, agentId: foreignAgentId, status: "succeeded", sessionIdBefore: "foreign-session", contextSnapshot: { issueId: foreignIssueId }, usageJson: { taskSessionReused: true, configFreshness: { session: { nextFingerprint: "foreign-security" } } } },
    ]);
    await db.insert(costEvents).values([
      { companyId: targetCompanyId, agentId: targetAgentId, heartbeatRunId: targetRunId, provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-5", inputTokens: 10, cachedInputTokens: 20, outputTokens: 5, costCents: 3, occurredAt: new Date("2026-08-02T00:00:00.000Z") },
      { companyId: foreignCompanyId, agentId: foreignAgentId, heartbeatRunId: foreignRunId, provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-5", inputTokens: 999, cachedInputTokens: 999, outputTokens: 999, costCents: 999, occurredAt: new Date("2026-08-02T00:00:00.000Z") },
    ]);

    const report = await costs.completedIssueTelemetry(targetCompanyId, {
      from: new Date("2026-08-01T00:00:00.000Z"),
      toExclusive: new Date("2026-08-15T00:00:00.000Z"),
    });

    expect(report.companyId).toBe(targetCompanyId);
    expect(report.completedIssues).toHaveLength(1);
    expect(report.completedIssues[0]).toMatchObject({
      issueId: targetIssueId,
      companyId: targetCompanyId,
      accounting: { total: { processedTokens: 35, costCents: 3 } },
      boundary: { evidenceComplete: true, sessionConfigFingerprints: ["target-security"] },
    });
    expect(JSON.stringify(report)).not.toContain(foreignIssueId);
    expect(JSON.stringify(report)).not.toContain("foreign-security");
  });

  it("aggregates cost event sums above int32 without raising Postgres integer overflow", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Overflow Project",
      status: "active",
    });

    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        projectId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 2_000_000_000,
        cachedInputTokens: 0,
        outputTokens: 200_000_000,
        costCents: 2_000_000_000,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        projectId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 2_000_000_000,
        cachedInputTokens: 10,
        outputTokens: 200_000_000,
        costCents: 2_000_000_000,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
      },
    ]);

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };

    const [byAgentRow] = await costs.byAgent(companyId, range);
    const [byProjectRow] = await costs.byProject(companyId, range);
    const [byAgentModelRow] = await costs.byAgentModel(companyId, range);

    expect(byAgentRow?.costCents).toBe(4_000_000_000);
    expect(byAgentRow?.inputTokens).toBe(4_000_000_000);
    expect(byProjectRow?.costCents).toBe(4_000_000_000);
    expect(byAgentModelRow?.costCents).toBe(4_000_000_000);
  });

  it("aggregates issue costs across recursive descendants only", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const grandchildIssueId = randomUUID();
    const harnessIssueId = randomUUID();
    const siblingIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
      },
      {
        id: grandchildIssueId,
        companyId,
        parentId: childIssueId,
        title: "Grandchild",
        status: "done",
        priority: "medium",
        issueNumber: 3,
        identifier: "TST-3",
      },
      {
        id: harnessIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Hidden skill test harness",
        status: "done",
        priority: "medium",
        issueNumber: 5,
        identifier: "TST-5",
        workMode: "skill_test",
        harnessKind: "skill_test",
      },
      {
        id: siblingIssueId,
        companyId,
        title: "Sibling",
        status: "done",
        priority: "medium",
        issueNumber: 4,
        identifier: "TST-4",
      },
    ]);
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: rootIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 10,
        cachedInputTokens: 1,
        outputTokens: 2,
        costCents: 100,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 20,
        cachedInputTokens: 2,
        outputTokens: 4,
        costCents: 200,
        occurredAt: new Date("2026-04-10T00:01:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: grandchildIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 30,
        cachedInputTokens: 3,
        outputTokens: 6,
        costCents: 300,
        occurredAt: new Date("2026-04-10T00:02:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: siblingIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 40,
        cachedInputTokens: 4,
        outputTokens: 8,
        costCents: 400,
        occurredAt: new Date("2026-04-10T00:03:00.000Z"),
      },
    ]);

    const summary = await costs.issueTreeSummary(companyId, rootIssueId);

    expect(summary).toEqual({
      issueId: rootIssueId,
      issueCount: 3,
      includeDescendants: true,
      costCents: 600,
      inputTokens: 60,
      cachedInputTokens: 6,
      outputTokens: 12,
      runCount: 0,
      runtimeMs: 0,
    });
  });

  it("aggregates run wall-clock duration across the recursive issue tree", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const grandchildIssueId = randomUUID();
    const harnessIssueId = randomUUID();
    const siblingIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Run Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child",
        status: "in_progress",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
      },
      {
        id: grandchildIssueId,
        companyId,
        parentId: childIssueId,
        title: "Grandchild",
        status: "done",
        priority: "medium",
        issueNumber: 3,
        identifier: "TST-3",
      },
      {
        id: siblingIssueId,
        companyId,
        title: "Sibling",
        status: "done",
        priority: "medium",
        issueNumber: 4,
        identifier: "TST-4",
      },
      {
        id: harnessIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Harness child",
        status: "done",
        priority: "medium",
        workMode: "skill_test",
        harnessKind: "skill_test",
        issueNumber: 5,
        identifier: "TST-5",
      },
    ]);

    const linkedViaContextRunId = randomUUID();
    const linkedViaActivityRunId = randomUUID();
    const grandchildRunId = randomUUID();
    const harnessRunId = randomUUID();
    const siblingRunId = randomUUID();
    const livePartialRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      // 60s run linked to root via contextSnapshot.issueId
      {
        id: linkedViaContextRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:00:00.000Z"),
        finishedAt: new Date("2026-04-10T00:01:00.000Z"),
        contextSnapshot: { issueId: rootIssueId },
      },
      // 120s run linked to child via activity_log
      {
        id: linkedViaActivityRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:05:00.000Z"),
        finishedAt: new Date("2026-04-10T00:07:00.000Z"),
      },
      // 30s run linked to grandchild
      {
        id: grandchildRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:10:00.000Z"),
        finishedAt: new Date("2026-04-10T00:10:30.000Z"),
        contextSnapshot: { issueId: grandchildIssueId },
      },
      // 45s harness run under root - should be excluded from visible issue tree rollups
      {
        id: harnessRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:15:00.000Z"),
        finishedAt: new Date("2026-04-10T00:15:45.000Z"),
        contextSnapshot: { issueId: harnessIssueId },
      },
      // sibling run NOT under root – should be excluded
      {
        id: siblingRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:20:00.000Z"),
        finishedAt: new Date("2026-04-10T00:21:00.000Z"),
        contextSnapshot: { issueId: siblingIssueId },
      },
      // Still-running run on child (no finishedAt) – should contribute (now - startedAt)
      {
        id: livePartialRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
        startedAt: new Date(Date.now() - 5_000),
        contextSnapshot: { issueId: childIssueId },
      },
    ]);

    await db.insert(activityLog).values({
      companyId,
      runId: linkedViaActivityRunId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: childIssueId,
      details: {},
    });

    const summary = await costs.issueTreeSummary(companyId, rootIssueId);

    expect(summary.issueCount).toBe(3);
    // 3 finished runs in tree (root, child via activity, grandchild) + 1 live run
    expect(summary.runCount).toBe(4);
    // 60s + 120s + 30s = 210s = 210_000ms from finished runs.
    // Live run adds ~5_000ms; allow some slack so the assertion isn't flaky.
    expect(summary.runtimeMs).toBeGreaterThanOrEqual(210_000 + 4_000);
    expect(summary.runtimeMs).toBeLessThan(210_000 + 60_000);

    // excludeRoot drops the root issue's own runs (the 60s contextSnapshot run)
    // while keeping the child + grandchild runs and any live child run.
    const descendantsOnly = await costs.issueTreeSummary(companyId, rootIssueId, {
      excludeRoot: true,
    });
    expect(descendantsOnly.issueCount).toBe(2);
    expect(descendantsOnly.runCount).toBe(3);
    // 120s + 30s = 150s + ~5s live run
    expect(descendantsOnly.runtimeMs).toBeGreaterThanOrEqual(150_000 + 4_000);
    expect(descendantsOnly.runtimeMs).toBeLessThan(150_000 + 60_000);
  });

  it("aggregates finance event sums above int32 without raising Postgres integer overflow", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(financeEvents).values([
      {
        companyId,
        biller: "openai",
        eventKind: "invoice",
        amountCents: 2_000_000_000,
        currency: "USD",
        direction: "debit",
        estimated: false,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        biller: "openai",
        eventKind: "invoice",
        amountCents: 2_000_000_000,
        currency: "USD",
        direction: "debit",
        estimated: true,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
      },
    ]);

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };

    const summary = await finance.summary(companyId, range);
    const [byKindRow] = await finance.byKind(companyId, range);

    expect(summary.debitCents).toBe(4_000_000_000);
    expect(summary.estimatedDebitCents).toBe(2_000_000_000);
    expect(byKindRow?.debitCents).toBe(4_000_000_000);
    expect(byKindRow?.netCents).toBe(4_000_000_000);
  });
});
