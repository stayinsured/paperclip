import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notFound } from "../errors.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const issueId = "11111111-1111-4111-8111-111111111111";
const targetId = "33333333-3333-4333-8333-333333333333";
const receiptId = "44444444-4444-4444-8444-444444444444";

const mockAccess = vi.hoisted(() => ({ decide: vi.fn() }));
const mockIssues = vi.hoisted(() => ({ getById: vi.fn() }));
const mockHeartbeat = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockLedger = vi.hoisted(() => ({
  listForIssue: vi.fn(),
  getReceiptForIssue: vi.fn(),
  registerProposal: vi.fn(),
  validateTarget: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccess,
  heartbeatService: () => mockHeartbeat,
  issueService: () => mockIssues,
  logActivity: mockLogActivity,
}));

vi.mock("../services/reflection-ledger.js", () => ({
  reflectionLedgerService: () => mockLedger,
}));

function actor(company = companyId) {
  return {
    type: "agent",
    agentId: "qa-agent",
    runId: "qa-run",
    companyId: company,
    source: "agent_key",
  };
}

async function createApp(requestActor = actor()) {
  const [{ reflectionEvidenceRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/reflection-evidence.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: unknown }).actor = requestActor;
    next();
  });
  app.use("/api", reflectionEvidenceRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("reflection evidence routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssues.getById.mockResolvedValue({
      id: issueId,
      companyId,
      projectId: null,
      parentId: null,
      assigneeAgentId: "qa-owner",
      assigneeUserId: null,
      status: "in_review",
    });
    mockAccess.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_issue_assignment",
      explanation: "Issue reader",
    });
    mockLedger.listForIssue.mockResolvedValue({
      targets: [{ id: targetId, state: "applied" }],
      receipts: [{ id: receiptId, ledgerTargetId: targetId }],
    });
    mockLedger.getReceiptForIssue.mockResolvedValue({ id: receiptId, ledgerTargetId: targetId });
    mockLedger.validateTarget
      .mockResolvedValueOnce({
        changed: true,
        target: { id: targetId, targetKey: "agent:target:instructions", state: "independently_validated" },
      })
      .mockResolvedValueOnce({
        changed: false,
        target: { id: targetId, targetKey: "agent:target:instructions", state: "independently_validated" },
      });
    mockHeartbeat.wakeup.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("uses issue-read authorization without requiring agent configuration access", async () => {
    const response = await request(await createApp())
      .get(`/api/issues/${issueId}/reflection-evidence`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      targets: [{ id: targetId }],
      receipts: [{ id: receiptId }],
    });
    expect(mockAccess.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "issue:read" }));
    expect(mockAccess.decide).not.toHaveBeenCalledWith(expect.objectContaining({ action: "agent_config:read" }));
  });

  it("hides cross-company issues and denies receipts from unrelated issues", async () => {
    const crossCompany = await request(await createApp(actor("55555555-5555-4555-8555-555555555555")))
      .get(`/api/issues/${issueId}/reflection-evidence`);
    expect(crossCompany.status).toBe(404);
    expect(mockLedger.listForIssue).not.toHaveBeenCalled();

    mockLedger.getReceiptForIssue.mockRejectedValueOnce(notFound("Instruction mutation receipt not found"));
    const unrelated = await request(await createApp())
      .get(`/api/issues/${issueId}/reflection-receipts/${receiptId}`);
    expect(unrelated.status).toBe(404);
  });

  it("wakes the issue owner only for a new validation transition", async () => {
    const app = await createApp();
    const first = await request(app)
      .post(`/api/issues/${issueId}/reflection-targets/${targetId}/validate`)
      .send({ version: 1, evidenceMarkdown: "Exact readback verified." });
    const replay = await request(app)
      .post(`/api/issues/${issueId}/reflection-targets/${targetId}/validate`)
      .send({ version: 1, evidenceMarkdown: "Exact readback verified." });

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(first.body.replay).toBe(false);
    expect(replay.body.replay).toBe(true);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith("qa-owner", expect.objectContaining({
      idempotencyKey: `reflection-evidence:${targetId}:independently_validated`,
    }));
  });
});
