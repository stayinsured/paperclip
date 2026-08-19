import { describe, expect, it } from "vitest";
import {
  deterministicOperationKey,
  isOutlineActiveConfig,
  outcomeIdentity,
  parseModuleConfig,
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
import {
  OutlineAmbiguousWriteError,
  OutlineMcpError,
  createOutlineRuntime,
  outlineConfigurationFingerprint,
  renderOutlineShadowPreview,
  type OutlineCompletionSource,
  type OutlineDestinationConfig,
  type OutlineDocument,
  type OutlineMaterialityAssessment,
  type OutlineModuleActivation,
  type OutlineMcpPort,
  type OutlineShadowPreview,
} from "../src/modules/outline/index.js";

const NOW = new Date("2026-08-07T10:00:00.000Z");
const audit: AuditIdentity = { actorType: "system", actorId: null, runId: "run-1" };
const ISSUE_ID = "00000000-0000-4000-8000-000000000002";
const POLICY_VERSION = "materiality-v1";

const completionSource: OutlineCompletionSource = {
  companyId: "company-a",
  issueId: ISSUE_ID,
  issueIdentifier: "STA-42",
  issueTitle: "Introduce a durable webhook ledger",
  issueUrl: "https://paperclip.example/STA/issues/STA-42?token=should-not-survive",
  completedAt: "2026-08-07T10:00:00.000Z",
};

const destination: OutlineDestinationConfig = {
  accessMode: "mcp",
  connectionId: "outline-sandbox",
  connectionRevision: "oauth-v1",
  tools: {
    documentsInfo: "outline:documents_info",
    documentsCreate: "outline:documents_create",
    documentsUpdate: "outline:documents_update",
  },
  targets: {
    architecture: {
      collectionId: "10000000-0000-4000-8000-000000000001",
      parentDocumentId: "20000000-0000-4000-8000-000000000001",
      parentTitle: "Architecture",
    },
    reports: {
      collectionId: "10000000-0000-4000-8000-000000000001",
      parentDocumentId: "20000000-0000-4000-8000-000000000002",
      parentTitle: "Reports",
    },
    processes: {
      collectionId: "10000000-0000-4000-8000-000000000001",
      parentDocumentId: "20000000-0000-4000-8000-000000000003",
      parentTitle: "Processes",
    },
  },
};

function materialAssessment(): OutlineMaterialityAssessment {
  return {
    classification: "material",
    reasonCodes: ["architecture_changed"],
    targetClass: "Architecture",
    canonicalIdentity: {
      assessmentKey: `v1:paperclip:${completionSource.issueIdentifier}:${POLICY_VERSION}`,
      documentKey: "v1:architecture:webhook-delivery",
      proposedAction: "create",
      existingDocumentRef: null,
    },
    evidence: [{
      kind: "issue",
      sourceRef: completionSource.issueIdentifier,
      claim: "Introduced durable idempotency and redacted receipts for ops@example.com.",
    }],
    safeDraft: {
      template: "architecture_decision",
      title: "Webhook delivery architecture",
      bodyMarkdown: "# Webhook delivery architecture\n\nUse one canonical ledger. api_key=super-secret\n\nhttps://evidence.example/test?token=private",
    },
    review: { required: false, questions: [] },
  };
}

function preview(): OutlineShadowPreview {
  const result = renderOutlineShadowPreview({
    source: completionSource,
    assessment: materialAssessment(),
    destination,
    policyVersion: POLICY_VERSION,
    generatedAt: NOW,
  });
  if (!result) throw new Error("expected material preview");
  return result;
}

function activationPayload(overrides: {
  authorization?: Partial<OutlineModuleActivation["authorization"]>;
  expiresAt?: string;
} = {}): OutlineModuleActivation {
  const fingerprint = outlineConfigurationFingerprint(destination);
  return {
    schemaVersion: 1,
    destination,
    authorization: {
      enabled: true,
      readOnly: false,
      externalWritesEnabled: true,
      exactConfigurationApproval: {
        status: "accepted",
        configurationRevisionId: "30000000-0000-4000-8000-000000000001",
        configurationFingerprint: fingerprint,
        interactionId: "40000000-0000-4000-8000-000000000001",
        acceptedAt: "2026-08-07T09:30:00.000Z",
      },
      writerProofs: [{
        accessMode: "mcp",
        connectionId: destination.connectionId,
        collectionId: destination.targets.architecture.collectionId,
        permission: "read_write",
        allowedParentDocumentIds: Object.values(destination.targets).map((target) => target.parentDocumentId),
        configurationFingerprint: fingerprint,
        verifiedAt: "2026-08-07T09:40:00.000Z",
        expiresAt: overrides.expiresAt ?? "2026-08-08T09:40:00.000Z",
        tools: { ...destination.tools },
      }],
      ...overrides.authorization,
    },
  };
}

function parseConfig(input: Record<string, unknown>): ModuleConfig {
  return parseModuleConfig({
    companyId: "company-a",
    projectId: "project-a",
    module: "outline",
    policyVersion: POLICY_VERSION,
    ...input,
  });
}

function activeConfig(overrides: Record<string, unknown> = {}): ModuleConfig {
  return parseConfig({
    enabled: true,
    readOnly: false,
    destinationEnabled: true,
    destinationKey: destination.connectionId,
    outlineActivation: activationPayload(),
    ...overrides,
  });
}

function sourceCandidate(config: ModuleConfig, overrides: Partial<SourceCandidate> = {}): SourceCandidate {
  return {
    companyId: config.companyId,
    projectId: config.projectId,
    module: config.module,
    sourceKind: "paperclip_issue",
    sourceId: ISSUE_ID,
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
  now = NOW;
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
    if (!force && operation.nextAttemptAt && new Date(operation.nextAttemptAt) > this.now) {
      return false;
    }
    operation.status = "pending";
    operation.attempt += 1;
    this.leases.set(operationId, leaseToken);
    return true;
  }

  private complete(
    companyId: string,
    operationId: string,
    leaseToken: string,
    receipt: RedactedReceipt,
    status: "shadowed" | "published",
  ): boolean {
    const target = [...this.operations.values()].find((op) => op.companyId === companyId && op.id === operationId);
    if (!target || this.leases.get(operationId) !== leaseToken) return false;
    target.status = status;
    target.outcomeReceipt = receipt;
    target.nextAttemptAt = null;
    this.leases.delete(operationId);
    return true;
  }

  async completeShadow(
    companyId: string,
    operationId: string,
    leaseToken: string,
    receipt: RedactedReceipt,
  ): Promise<boolean> {
    return this.complete(companyId, operationId, leaseToken, receipt, "shadowed");
  }

  async completePublish(
    companyId: string,
    operationId: string,
    leaseToken: string,
    receipt: RedactedReceipt,
  ): Promise<boolean> {
    return this.complete(companyId, operationId, leaseToken, receipt, "published");
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
    if (!operation || !["shadowed", "skipped", "published"].includes(operation.status)) {
      throw new Error("cursor attempted before durable terminal ledger");
    }
    const key = `${candidate.companyId}:${candidate.projectId}:${candidate.module}`;
    const current = this.cursors.get(key);
    if (!current || current < candidate.cursorValue) this.cursors.set(key, candidate.cursorValue);
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
    if (!this.exceptions.some((value) =>
      value.companyId === input.companyId && value.kind === input.kind && value.operationId === input.operationId)) {
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
    _audit: AuditIdentity,
  ): Promise<ReconciliationRun> {
    const run: ReconciliationRun = {
      id: `reconcile-${this.runs.length + 1}`,
      companyId,
      trigger,
      status: "running",
      mode: "shadow",
      scanned: 0,
      shadowed: 0,
      published: 0,
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
      generatedAt: this.now.toISOString(),
      mode: this.configs.some((config) => isOutlineActiveConfig(config)) ? "active" : "shadow",
      externalWrites: 0,
      modules: [],
      operations: [],
      exceptions: this.exceptions.map((value, index) => ({
        id: `exception-${index + 1}`,
        module: value.module as ModuleConfig["module"],
        operationId: value.operationId,
        kind: value.kind,
        summary: value.summary,
        attempt: 0,
        createdAt: this.now.toISOString(),
      })),
      recentRuns: [],
    };
  }
}

class MemoryOutlineMcp implements OutlineMcpPort {
  documents = new Map<string, OutlineDocument>();
  calls: string[] = [];
  rateLimitGet = false;
  ambiguousCreate = false;
  commitAmbiguousCreate = false;

  async getDocument(id: string): Promise<OutlineDocument | null> {
    this.calls.push(`get:${id}`);
    if (this.rateLimitGet) throw new OutlineMcpError("outline_mcp_rate_limited", true, 1_500);
    return this.documents.get(id) ?? null;
  }

  async createDocument(input: {
    id: string;
    collectionId: string;
    parentDocumentId: string;
    title: string;
    text: string;
  }): Promise<OutlineDocument> {
    this.calls.push(`create:${input.id}`);
    const document: OutlineDocument = { ...input };
    if (!this.ambiguousCreate || this.commitAmbiguousCreate) this.documents.set(input.id, document);
    if (this.ambiguousCreate) throw new OutlineAmbiguousWriteError();
    return document;
  }

  async updateDocument(input: { id: string; title: string; text: string }): Promise<OutlineDocument> {
    this.calls.push(`update:${input.id}`);
    const existing = this.documents.get(input.id);
    if (!existing) throw new Error("missing document");
    const updated = { ...existing, ...input };
    this.documents.set(input.id, updated);
    return updated;
  }
}

interface Harness {
  repository: MemoryRepository;
  mcp: MemoryOutlineMcp;
  reconciler: ShadowReconciler;
  previews: Map<string, OutlineShadowPreview>;
}

function harness(input: {
  config?: ModuleConfig;
  mcp?: MemoryOutlineMcp;
  expiresAt?: string;
  withMcpRuntime?: boolean;
} = {}): Harness {
  const repository = new MemoryRepository();
  const mcp = input.mcp ?? new MemoryOutlineMcp();
  const config = input.config ?? activeConfig(
    input.expiresAt ? { outlineActivation: activationPayload({ expiresAt: input.expiresAt }) } : {},
  );
  repository.configs.push(config);
  const previews = new Map<string, OutlineShadowPreview>();
  const runtime = createOutlineRuntime({
    assessments: {
      async get(companyId, sourceIssueId, policyVersion) {
        const stored = previews.get(`${companyId}|${sourceIssueId}|${policyVersion}`);
        return stored ? { preview: stored } : null;
      },
    },
    mcpConnectionFactory: input.withMcpRuntime === false ? undefined : () => mcp,
    now: () => repository.now,
  });
  const reconciler = new ShadowReconciler(repository, () => repository.now, runtime);
  return { repository, mcp, reconciler, previews };
}

function seedCandidate(harness: Harness): void {
  const config = harness.repository.configs[0]!;
  harness.repository.candidates.push(sourceCandidate(config));
  harness.previews.set(`${config.companyId}|${ISSUE_ID}|${config.policyVersion}`, preview());
}

function firstOperation(harness: Harness): OperationRecord {
  return [...harness.repository.operations.values()][0]!;
}

describe("outline activation configuration gates", () => {
  it("accepts an approved outline activation only with the active switch combination", () => {
    const config = activeConfig();
    expect(isOutlineActiveConfig(config)).toBe(true);
    expect(config.destinationKey).toBe(destination.connectionId);
    expect(config.outlineActivation?.authorization.exactConfigurationApproval?.status).toBe("accepted");
  });

  it("keeps the structural shadow-only limit without an approved activation", () => {
    expect(() => parseConfig({ enabled: true, readOnly: false, destinationEnabled: false })).toThrow(/shadow-only/);
    expect(() => parseConfig({ enabled: true, readOnly: true, destinationEnabled: true })).toThrow(/shadow-only/);
    expect(() => parseModuleConfig({
      companyId: "company-a",
      projectId: "project-a",
      module: "clickup",
      enabled: true,
      readOnly: false,
      destinationEnabled: true,
      destinationKey: destination.connectionId,
      outlineActivation: activationPayload(),
    })).toThrow(/activation payload|shadow-only/);
  });

  it("keeps kill-switch (dormant) forms valid but inactive", () => {
    const disabled = activeConfig({ enabled: false });
    const readOnly = activeConfig({ enabled: true, readOnly: true, destinationEnabled: false });
    expect(isOutlineActiveConfig(disabled)).toBe(false);
    expect(isOutlineActiveConfig(readOnly)).toBe(false);
  });

  it("rejects an activation whose destination key does not match the approved connection", () => {
    expect(() => activeConfig({ destinationKey: "some-other-connection" })).toThrow(/connectionId/);
  });
});

describe("approved outline activation path in reconciliation", () => {
  it("creates the deterministic document behind the approved gates", async () => {
    const h = harness();
    seedCandidate(h);

    const result = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });

    const expected = preview();
    expect(h.mcp.calls).toEqual([
      `get:${expected.deterministicDocumentId}`,
      `create:${expected.deterministicDocumentId}`,
      `get:${expected.deterministicDocumentId}`,
    ]);
    expect(result).toMatchObject({
      mode: "active",
      scanned: 1,
      published: 1,
      externalWrites: 1,
      exceptions: 0,
    });
    const operation = firstOperation(h);
    expect(operation.status).toBe("published");
    const receipt = operation.outcomeReceipt as RedactedReceipt;
    expect(receipt).toMatchObject({
      category: "publish",
      code: "publish_created",
      status: "created",
      externalWriteAttempted: true,
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("Webhook delivery architecture");
    expect(serialized).not.toContain("canonical ledger");
    expect(serialized).not.toContain("token=private");
    expect(h.repository.cursors).toHaveLength(1);
  });

  it("updates an existing document when the preview content changed", async () => {
    const expected = preview();
    const h = harness();
    h.mcp.documents.set(expected.deterministicDocumentId, {
      id: expected.deterministicDocumentId,
      collectionId: expected.collectionId,
      parentDocumentId: expected.parentDocumentId,
      title: expected.title,
      text: "# Stale previous body\n",
    });
    seedCandidate(h);

    const result = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });

    expect(h.mcp.calls).toEqual([
      `get:${expected.deterministicDocumentId}`,
      `update:${expected.deterministicDocumentId}`,
      `get:${expected.deterministicDocumentId}`,
    ]);
    expect(result).toMatchObject({ published: 1, externalWrites: 1 });
    expect(firstOperation(h).status).toBe("published");
    expect((firstOperation(h).outcomeReceipt as RedactedReceipt).code).toBe("publish_updated");
  });

  it("treats an unchanged rerun as a no-op without provider writes", async () => {
    const expected = preview();
    const h = harness();
    h.mcp.documents.set(expected.deterministicDocumentId, {
      id: expected.deterministicDocumentId,
      collectionId: expected.collectionId,
      parentDocumentId: expected.parentDocumentId,
      title: expected.title,
      text: expected.body,
    });
    seedCandidate(h);

    const result = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });

    expect(h.mcp.calls).toEqual([`get:${expected.deterministicDocumentId}`]);
    expect(result).toMatchObject({ published: 1, externalWrites: 0 });
    expect(firstOperation(h).outcomeReceipt).toMatchObject({
      code: "publish_already_current",
      externalWriteAttempted: false,
    });
  });

  it("fails closed on a wrong-target document without writing", async () => {
    const expected = preview();
    const h = harness();
    h.mcp.documents.set(expected.deterministicDocumentId, {
      id: expected.deterministicDocumentId,
      collectionId: "99999999-0000-4000-8000-000000000009",
      parentDocumentId: "88888888-0000-4000-8000-000000000008",
      title: "Foreign document",
      text: "unrelated",
    });
    seedCandidate(h);

    const result = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });

    expect(h.mcp.calls).toEqual([`get:${expected.deterministicDocumentId}`]);
    expect(result).toMatchObject({ published: 0, externalWrites: 0, exceptions: 1 });
    const operation = firstOperation(h);
    expect(operation.status).toBe("failed");
    expect(operation.nextAttemptAt).toBeNull();
    expect(h.repository.exceptions.map((value) => value.kind)).toEqual(["permanent_failure"]);
    expect(h.repository.cursors).toHaveLength(0);
  });

  it("records a bounded rate-limit retry and succeeds on the later pass", async () => {
    const h = harness();
    h.mcp.rateLimitGet = true;
    seedCandidate(h);

    const limited = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });
    expect(limited).toMatchObject({ published: 0, externalWrites: 0, exceptions: 1 });
    const operation = firstOperation(h);
    expect(operation.status).toBe("retry_wait");
    // Broker-supplied retry delay (1500ms) is preserved over the default backoff.
    expect(operation.nextAttemptAt).toBe("2026-08-07T10:00:01.500Z");
    expect(h.repository.exceptions.map((value) => value.kind)).toEqual(["rate_limited"]);
    expect(h.repository.cursors).toHaveLength(0);

    h.mcp.rateLimitGet = false;
    h.repository.now = new Date("2026-08-07T10:00:02.000Z");
    const recovered = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });
    expect(recovered).toMatchObject({ published: 1, externalWrites: 1 });
    expect(h.mcp.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(firstOperation(h).status).toBe("published");
  });

  it("reconciles an ambiguous result before any retry", async () => {
    const expected = preview();
    const h = harness();
    h.mcp.ambiguousCreate = true;
    h.mcp.commitAmbiguousCreate = true;
    seedCandidate(h);

    const result = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });

    expect(result).toMatchObject({ published: 1, externalWrites: 1, exceptions: 0 });
    expect(firstOperation(h).status).toBe("published");
    expect(firstOperation(h).outcomeReceipt).toMatchObject({
      code: "publish_already_current",
      externalWriteAttempted: true,
    });
    expect(h.mcp.documents.get(expected.deterministicDocumentId)?.text).toBe(expected.body);
  });

  it("retries safely when an ambiguous write did not commit", async () => {
    const h = harness();
    h.mcp.ambiguousCreate = true;
    h.mcp.commitAmbiguousCreate = false;
    seedCandidate(h);

    const ambiguous = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });
    expect(ambiguous).toMatchObject({ published: 0, externalWrites: 0, exceptions: 1 });
    const operation = firstOperation(h);
    expect(operation.status).toBe("retry_wait");

    h.mcp.ambiguousCreate = false;
    h.repository.now = new Date("2026-08-07T10:00:05.000Z");
    const recovered = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });
    expect(recovered).toMatchObject({ published: 1, externalWrites: 1 });
    expect(h.mcp.calls.filter((call) => call.startsWith("create:"))).toHaveLength(2);
    expect(h.mcp.documents).toHaveLength(1);
  });

  it("prevents duplicate publishes across overlapping reconciliations", async () => {
    const h = harness();
    seedCandidate(h);

    const first = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });
    const second = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });

    expect(first).toMatchObject({ published: 1, duplicates: 0 });
    expect(second).toMatchObject({ published: 0, duplicates: 1, externalWrites: 0 });
    expect(h.mcp.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(h.repository.operations).toHaveLength(1);
  });

  it("disable rollback: reconfigured shadow mode performs zero provider writes and preserves state", async () => {
    const h = harness();
    seedCandidate(h);
    const expected = preview();

    await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });
    const callsAfterActivate = h.mcp.calls.length;
    const operationBefore = firstOperation(h);
    const cursorBefore = h.repository.cursors.get("company-a|project-a|outline");

    // Kill switch: the board restores the shadow switch combination while the
    // activation payload and all durable state survive.
    const disabledConfig = activeConfig({ enabled: false });
    h.repository.configs[0] = disabledConfig;
    const secondCandidate = sourceCandidate(disabledConfig, {
      sourceId: "00000000-0000-4000-8000-000000000003",
      sourceVersion: "paperclip-v1:def",
      cursorValue: "2026-08-07T10:00:01.000Z|issue-b",
    });
    h.repository.candidates.push(secondCandidate);

    const disabled = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });
    expect(disabled).toMatchObject({ mode: "shadow", scanned: 0, externalWrites: 0 });
    expect(h.mcp.calls).toHaveLength(callsAfterActivate);

    // Read-only observation form also stays zero-write.
    h.repository.configs[0] = activeConfig({ enabled: true, readOnly: true, destinationEnabled: false });
    const readOnly = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });
    expect(readOnly).toMatchObject({ mode: "shadow", externalWrites: 0 });
    expect(h.mcp.calls).toHaveLength(callsAfterActivate);

    // Prior published state survived the rollback untouched.
    const operationAfter = h.repository.operations.get(`${operationBefore.companyId}:outline:${operationBefore.operationKey}`)!;
    expect(operationAfter.status).toBe("published");
    expect(operationAfter.outcomeReceipt).toEqual(operationBefore.outcomeReceipt);
    expect(h.repository.cursors.get("company-a|project-a|outline")).toBe(cursorBefore);
    expect(h.mcp.documents.get(expected.deterministicDocumentId)?.text).toBe(expected.body);
  });
});

describe("activation fail-closed behavior", () => {
  it("default configuration performs zero provider writes even with a material preview available", async () => {
    const h = harness({ config: parseConfig({ enabled: true, readOnly: true, destinationEnabled: false }) });
    seedCandidate(h);

    const result = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });

    expect(result).toMatchObject({ mode: "shadow", shadowed: 1, published: 0, externalWrites: 0 });
    expect(h.mcp.calls).toHaveLength(0);
    expect(firstOperation(h).status).toBe("shadowed");
  });

  it("denies an expired writer proof with a visible exception and zero writes", async () => {
    const h = harness({ expiresAt: "2026-08-07T09:59:00.000Z" });
    seedCandidate(h);

    const result = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });

    expect(result).toMatchObject({ mode: "shadow", externalWrites: 0 });
    expect(h.mcp.calls).toHaveLength(0);
    expect(h.repository.exceptions.map((value) => value.kind)).toContain("outline_writer_proof_expired");
    expect(firstOperation(h).status).toBe("shadowed");
  });

  it("fails closed when no MCP runtime is bound to the host", async () => {
    const h = harness({ withMcpRuntime: false });
    seedCandidate(h);

    const result = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });

    expect(result).toMatchObject({ mode: "shadow", externalWrites: 0 });
    expect(h.mcp.calls).toHaveLength(0);
    expect(h.repository.exceptions.map((value) => value.kind)).toContain("outline_mcp_runtime_unavailable");
    expect(firstOperation(h).status).toBe("shadowed");
  });

  it("observes in shadow without a durable preview instead of publishing nothing", async () => {
    const h = harness();
    const config = h.repository.configs[0]!;
    h.repository.candidates.push(sourceCandidate(config));
    // No preview stored for this issue.

    const result = await h.reconciler.reconcileCompany({ companyId: "company-a", trigger: "schedule", audit });

    expect(result).toMatchObject({ mode: "active", shadowed: 1, published: 0, externalWrites: 0 });
    expect(h.mcp.calls).toHaveLength(0);
    expect(firstOperation(h).status).toBe("shadowed");
  });
});
