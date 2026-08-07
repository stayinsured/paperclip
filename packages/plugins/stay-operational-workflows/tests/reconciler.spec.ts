import { describe, expect, it } from "vitest";
import {
  deterministicOperationKey,
  outcomeIdentity,
  type AuditIdentity,
  type ModuleConfig,
  type RedactedReceipt,
  type RetryDecision,
  type SourceCandidate,
} from "../src/contracts.js";
import { ShadowReconciler } from "../src/reconciler.js";
import type {
  OperationRecord,
  ReconciliationRun,
  ShadowReport,
  WorkflowRepository,
} from "../src/repository.js";

const audit: AuditIdentity = { actorType: "system", actorId: null, runId: "run-1" };

function moduleConfig(overrides: Partial<ModuleConfig> = {}): ModuleConfig {
  return {
    companyId: "company-a",
    projectId: "project-a",
    module: "outline",
    enabled: true,
    readOnly: true,
    destinationEnabled: false,
    destinationKey: "digital",
    sourceVersion: "paperclip-v1",
    policyVersion: "shadow-v1",
    maxAttempts: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 300_000,
    overlapSeconds: 300,
    batchSize: 200,
    ...overrides,
  };
}

function sourceCandidate(config: ModuleConfig, overrides: Partial<SourceCandidate> = {}): SourceCandidate {
  return {
    companyId: config.companyId,
    projectId: config.projectId,
    module: config.module,
    sourceKind: "paperclip_issue",
    sourceId: "issue-a",
    sourceVersion: "paperclip-v1:abc",
    policyVersion: config.policyVersion,
    cursorValue: "2026-08-07T10:00:00.000Z|issue-a",
    sourceStatus: "done",
    ...overrides,
  };
}

class MemoryRepository implements WorkflowRepository {
  readonly configs: ModuleConfig[] = [];
  readonly candidates: SourceCandidate[] = [];
  readonly operations = new Map<string, OperationRecord>();
  readonly cursors = new Map<string, string>();
  readonly exceptions: Array<{
    companyId: string;
    module: string;
    kind: string;
    summary: string;
    operationId: string | null;
  }> = [];
  readonly runs: ReconciliationRun[] = [];
  readonly timeline: string[] = [];
  invalidSchema = false;
  failCursorOnce = false;
  private nextId = 1;
  private readonly leases = new Map<string, string>();

  async upsertConfig(config: ModuleConfig): Promise<void> {
    const index = this.configs.findIndex((value) =>
      value.companyId === config.companyId
      && value.projectId === config.projectId
      && value.module === config.module);
    if (index === -1) this.configs.push(config);
    else this.configs[index] = config;
  }

  async listConfigs(companyId: string, enabledOnly = false): Promise<ModuleConfig[]> {
    return this.configs.filter((config) =>
      config.companyId === companyId && (!enabledOnly || config.enabled));
  }

  async listIssueCandidates(config: ModuleConfig, sourceId?: string): Promise<SourceCandidate[]> {
    if (this.invalidSchema) throw new Error("invalid raw schema customer@example.com");
    return this.candidates.filter((candidate) =>
      candidate.companyId === config.companyId
      && candidate.projectId === config.projectId
      && candidate.module === config.module
      && (!sourceId || candidate.sourceId === sourceId));
  }

  async ensureOperation(
    candidate: SourceCandidate,
    operationKey: string,
    _audit: AuditIdentity,
  ): Promise<OperationRecord> {
    const key = `${candidate.companyId}:${candidate.module}:${operationKey}`;
    const existing = this.operations.get(key);
    if (existing) return existing;
    const operation: OperationRecord = {
      id: `operation-${this.nextId++}`,
      companyId: candidate.companyId,
      projectId: candidate.projectId,
      module: candidate.module,
      operationKey,
      sourceKind: candidate.sourceKind,
      sourceId: candidate.sourceId,
      sourceVersion: candidate.sourceVersion,
      policyVersion: candidate.policyVersion,
      attempt: 0,
      status: "pending",
      outcomeIdentity: outcomeIdentity(operationKey),
      outcomeReceipt: {},
      nextAttemptAt: null,
      cursorValue: candidate.cursorValue,
    };
    this.operations.set(key, operation);
    this.timeline.push(`operation:${operation.id}:durable`);
    return operation;
  }

  async getOperation(companyId: string, operationId: string): Promise<OperationRecord | null> {
    return [...this.operations.values()].find((operation) =>
      operation.companyId === companyId && operation.id === operationId) ?? null;
  }

  async claimOperation(
    companyId: string,
    operationId: string,
    leaseToken: string,
    force: boolean,
  ): Promise<boolean> {
    const operation = await this.getOperation(companyId, operationId);
    if (!operation || this.leases.has(operationId)) return false;
    if (operation.status === "reconciling" && !force) return false;
    if (!["pending", "retry_wait", "reconciling"].includes(operation.status)) return false;
    if (!force && operation.nextAttemptAt && new Date(operation.nextAttemptAt) > new Date("2026-08-07T10:00:00.000Z")) {
      return false;
    }
    operation.status = "pending";
    operation.attempt += 1;
    this.leases.set(operationId, leaseToken);
    return true;
  }

  async completeShadow(
    companyId: string,
    operationId: string,
    leaseToken: string,
    receipt: RedactedReceipt,
  ): Promise<boolean> {
    const operation = await this.getOperation(companyId, operationId);
    if (!operation || this.leases.get(operationId) !== leaseToken) return false;
    operation.status = "shadowed";
    operation.outcomeReceipt = receipt;
    operation.nextAttemptAt = null;
    this.leases.delete(operationId);
    this.timeline.push(`operation:${operation.id}:shadowed`);
    return true;
  }

  async recordFailure(
    companyId: string,
    operationId: string,
    leaseToken: string,
    decision: RetryDecision,
    receipt: RedactedReceipt,
  ): Promise<boolean> {
    const operation = await this.getOperation(companyId, operationId);
    if (!operation || this.leases.get(operationId) !== leaseToken) return false;
    operation.status = decision.status;
    operation.nextAttemptAt = decision.retryAt;
    operation.outcomeReceipt = receipt;
    this.leases.delete(operationId);
    return true;
  }

  async advanceCursor(candidate: SourceCandidate, operationKey: string): Promise<void> {
    const operation = this.operations.get(`${candidate.companyId}:${candidate.module}:${operationKey}`);
    if (!operation || !["shadowed", "skipped"].includes(operation.status)) {
      throw new Error("cursor attempted before durable terminal ledger");
    }
    if (this.failCursorOnce) {
      this.failCursorOnce = false;
      throw new Error("simulated restart after ledger commit");
    }
    const key = `${candidate.companyId}:${candidate.projectId}:${candidate.module}`;
    const current = this.cursors.get(key);
    if (!current || current < candidate.cursorValue) this.cursors.set(key, candidate.cursorValue);
    this.timeline.push(`cursor:${operation.id}`);
  }

  async reopenForReplay(companyId: string, operationId: string): Promise<boolean> {
    const operation = await this.getOperation(companyId, operationId);
    if (!operation) return false;
    if (operation.status !== "shadowed") operation.status = "pending";
    operation.nextAttemptAt = null;
    this.leases.delete(operationId);
    return true;
  }

  async createException(input: {
    companyId: string;
    projectId: string;
    module: ModuleConfig["module"];
    operationId: string | null;
    exceptionKey: string;
    kind: string;
    summary: string;
    attempt: number;
    audit: AuditIdentity;
  }): Promise<void> {
    const existing = this.exceptions.find((value) =>
      value.companyId === input.companyId && value.kind === input.kind && value.operationId === input.operationId);
    if (!existing) {
      this.exceptions.push({
        companyId: input.companyId,
        module: input.module,
        kind: input.kind,
        summary: input.summary,
        operationId: input.operationId,
      });
    }
  }

  async startRun(
    companyId: string,
    trigger: ReconciliationRun["trigger"],
  ): Promise<ReconciliationRun> {
    const run: ReconciliationRun = {
      id: `reconcile-${this.runs.length + 1}`,
      companyId,
      trigger,
      status: "running",
      scanned: 0,
      shadowed: 0,
      duplicates: 0,
      conflicts: 0,
      exceptions: 0,
      externalWrites: 0,
    };
    this.runs.push(run);
    return run;
  }

  async finishRun(): Promise<void> {}

  async getReport(companyId: string): Promise<ShadowReport> {
    return {
      companyId,
      generatedAt: "2026-08-07T10:00:00.000Z",
      mode: "shadow",
      externalWrites: 0,
      modules: (await this.listConfigs(companyId)).map((config) => ({
        projectId: config.projectId,
        module: config.module,
        enabled: config.enabled,
        readOnly: config.readOnly,
        destinationEnabled: config.destinationEnabled,
        destinationKey: config.destinationKey,
        sourceVersion: config.sourceVersion,
        policyVersion: config.policyVersion,
      })),
      operations: [],
      exceptions: this.exceptions.filter((value) => value.companyId === companyId).map((value, index) => ({
        id: `exception-${index + 1}`,
        module: value.module as ModuleConfig["module"],
        operationId: value.operationId,
        kind: value.kind,
        summary: value.summary,
        attempt: 0,
        createdAt: "2026-08-07T10:00:00.000Z",
      })),
      recentRuns: this.runs.filter((run) => run.companyId === companyId).map((run) => ({
        id: run.id,
        trigger: run.trigger,
        status: run.status,
        scanned: run.scanned,
        shadowed: run.shadowed,
        duplicates: run.duplicates,
        conflicts: run.conflicts,
        exceptions: run.exceptions,
        externalWrites: 0,
        startedAt: "2026-08-07T10:00:00.000Z",
        completedAt: "2026-08-07T10:00:01.000Z",
      })),
    };
  }
}

describe("ShadowReconciler", () => {
  it("recovers event loss/restart and replay without duplicate operations", async () => {
    const repository = new MemoryRepository();
    const config = moduleConfig();
    repository.configs.push(config);
    repository.candidates.push(sourceCandidate(config));
    const reconciler = new ShadowReconciler(repository, () => new Date("2026-08-07T10:00:00.000Z"));

    const first = await reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });
    const second = await reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });
    const operation = [...repository.operations.values()][0]!;
    const replay = await reconciler.replay({ companyId: "company-a", operationId: operation.id, audit });

    expect(first).toMatchObject({ scanned: 1, shadowed: 1, externalWrites: 0 });
    expect(second).toMatchObject({ scanned: 1, duplicates: 1, externalWrites: 0 });
    expect(replay).toMatchObject({ scanned: 1, duplicates: 1, externalWrites: 0 });
    expect(repository.operations).toHaveLength(1);
    expect(operation).toMatchObject({
      companyId: "company-a",
      sourceVersion: "paperclip-v1:abc",
      policyVersion: "shadow-v1",
      attempt: 1,
      status: "shadowed",
      outcomeIdentity: expect.stringMatching(/^sha256:/),
    });
  });

  it("advances cursors only after durable ledger completion and heals a crash gap", async () => {
    const repository = new MemoryRepository();
    const config = moduleConfig();
    repository.configs.push(config);
    repository.candidates.push(sourceCandidate(config));
    repository.failCursorOnce = true;
    const reconciler = new ShadowReconciler(repository, () => new Date("2026-08-07T10:00:00.000Z"));

    const interrupted = await reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });
    expect(interrupted.exceptions).toBe(1);
    expect(repository.cursors).toHaveLength(0);
    expect([...repository.operations.values()][0]?.status).toBe("shadowed");

    const recovered = await reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });
    expect(recovered).toMatchObject({ duplicates: 1, externalWrites: 0 });
    expect(repository.cursors).toHaveLength(1);
    const shadowIndex = repository.timeline.findIndex((value) => value.endsWith(":shadowed"));
    const cursorIndex = repository.timeline.findIndex((value) => value.startsWith("cursor:"));
    expect(shadowIndex).toBeGreaterThanOrEqual(0);
    expect(cursorIndex).toBeGreaterThan(shadowIndex);
  });

  it("absorbs overlapping runs and keeps each module independently disableable", async () => {
    const repository = new MemoryRepository();
    const outline = moduleConfig({ module: "outline", enabled: true });
    const clickup = moduleConfig({ module: "clickup", enabled: false });
    const sentry = moduleConfig({ module: "sentry_slack", enabled: true });
    repository.configs.push(outline, clickup, sentry);
    repository.candidates.push(
      sourceCandidate(outline),
      sourceCandidate(clickup),
      sourceCandidate(sentry),
    );
    const first = new ShadowReconciler(repository, () => new Date("2026-08-07T10:00:00.000Z"));
    const second = new ShadowReconciler(repository, () => new Date("2026-08-07T10:00:00.000Z"));

    const results = await Promise.all([
      first.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit }),
      second.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit }),
    ]);

    expect(repository.operations).toHaveLength(2);
    expect([...repository.operations.values()].map((operation) => operation.module).sort())
      .toEqual(["outline", "sentry_slack"]);
    expect(results.reduce((sum, result) => sum + result.externalWrites, 0)).toBe(0);
  });

  it("fails closed on cross-company replay and exposes invalid schema exceptions without PII", async () => {
    const repository = new MemoryRepository();
    const config = moduleConfig();
    repository.configs.push(config);
    repository.candidates.push(sourceCandidate(config));
    const reconciler = new ShadowReconciler(repository, () => new Date("2026-08-07T10:00:00.000Z"));
    await reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });
    const operation = [...repository.operations.values()][0]!;
    await expect(reconciler.replay({
      companyId: "company-b",
      operationId: operation.id,
      audit,
    })).rejects.toThrow(/authorized company/);

    repository.invalidSchema = true;
    const invalid = await reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });
    const report = await reconciler.getReport("company-a");
    expect(invalid.exceptions).toBe(1);
    expect(report.exceptions).toEqual([
      expect.objectContaining({
        kind: "invalid_schema",
        summary: "Source candidate did not match the allowlisted shadow schema.",
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain("customer@example.com");
  });

  it("persists bounded retry and ambiguous-timeout states without cursor advancement", async () => {
    const repository = new MemoryRepository();
    const config = moduleConfig();
    const candidate429 = sourceCandidate(config);
    const candidateTimeout = sourceCandidate(config, {
      sourceId: "issue-timeout",
      sourceVersion: "paperclip-v1:def",
      cursorValue: "2026-08-07T10:00:01.000Z|issue-timeout",
    });
    repository.configs.push(config);

    const operation429 = await repository.ensureOperation(
      candidate429,
      deterministicOperationKey(candidate429),
      audit,
    );
    await repository.claimOperation("company-a", operation429.id, "lease-429", true);
    const reconciler = new ShadowReconciler(repository, () => new Date("2026-08-07T10:00:00.000Z"));
    await reconciler.recordAttemptFailure({
      companyId: "company-a",
      operationId: operation429.id,
      leaseToken: "lease-429",
      failure: { httpStatus: 429 },
      audit,
    });
    expect(operation429).toMatchObject({
      status: "retry_wait",
      nextAttemptAt: "2026-08-07T10:00:01.000Z",
    });

    const operationTimeout = await repository.ensureOperation(
      candidateTimeout,
      deterministicOperationKey(candidateTimeout),
      audit,
    );
    await repository.claimOperation("company-a", operationTimeout.id, "lease-timeout", true);
    await reconciler.recordAttemptFailure({
      companyId: "company-a",
      operationId: operationTimeout.id,
      leaseToken: "lease-timeout",
      failure: { kind: "ambiguous_timeout" },
      audit,
    });
    expect(operationTimeout).toMatchObject({ status: "reconciling", nextAttemptAt: null });
    expect(repository.cursors).toHaveLength(0);
    expect(repository.exceptions.map((value) => value.kind)).toEqual([
      "rate_limited",
      "ambiguous_timeout",
    ]);
  });
});
