import { randomUUID } from "node:crypto";
import {
  assertShadowOnly,
  classifyFailure,
  createRedactedReceipt,
  deterministicOperationKey,
  isOutlineActiveConfig,
  sha256,
  type AttemptFailure,
  type AuditIdentity,
  type ModuleConfig,
  type RedactedReceipt,
  type SourceCandidate,
  WorkflowRequestError,
} from "./contracts.js";
import { OutlinePublishingDeniedError } from "./modules/outline/authorization.js";
import { publishOutlinePreview } from "./modules/outline/publish.js";
import type { OutlinePublishReceipt, OutlineShadowPreview } from "./modules/outline/types.js";
import type { OutlineActivationBinding, OutlineRuntimePort } from "./modules/outline/runtime.js";
import type {
  OperationRecord,
  ReconciliationRun,
  ShadowReport,
  WorkflowRepository,
} from "./repository.js";

export interface ReconcileResult {
  runId: string;
  companyId: string;
  mode: "shadow" | "active";
  scanned: number;
  shadowed: number;
  published: number;
  duplicates: number;
  conflicts: number;
  exceptions: number;
  externalWrites: number;
}

export class ShadowReconciler {
  private readonly inFlightCompanies = new Set<string>();

  constructor(
    private readonly repository: WorkflowRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly outlineRuntime: OutlineRuntimePort | null = null,
  ) {}

  async reconcileCompany(input: {
    companyId: string;
    trigger: ReconciliationRun["trigger"];
    audit: AuditIdentity;
    sourceId?: string;
  }): Promise<ReconcileResult> {
    if (this.inFlightCompanies.has(input.companyId)) {
      return {
        runId: "coalesced",
        companyId: input.companyId,
        mode: "shadow",
        scanned: 0,
        shadowed: 0,
        published: 0,
        duplicates: 0,
        conflicts: 1,
        exceptions: 0,
        externalWrites: 0,
      };
    }

    this.inFlightCompanies.add(input.companyId);
    const run = await this.repository.startRun(input.companyId, input.trigger, input.audit);
    try {
      const configs = await this.repository.listConfigs(input.companyId, true);
      for (const config of configs) {
        const outline = await this.outlineBinding(config, run);
        if (!outline && !isOutlineActiveConfig(config)) assertShadowOnly(config);
        let candidates: SourceCandidate[];
        try {
          candidates = await this.repository.listIssueCandidates(config, input.sourceId);
        } catch {
          candidates = [];
          run.exceptions += 1;
          await this.repository.createException({
            companyId: input.companyId,
            projectId: config.projectId,
            module: config.module,
            operationId: null,
            exceptionKey: sha256([
              input.companyId,
              config.projectId,
              config.module,
              config.policyVersion,
              "invalid-source-schema",
            ].join("\u001f")),
            kind: "invalid_schema",
            summary: "Source candidate did not match the allowlisted shadow schema.",
            attempt: 0,
            audit: input.audit,
          });
        }
        for (const candidate of candidates) {
          try {
            await this.processCandidate(candidate, config, run, input.audit, false, outline);
          } catch {
            run.exceptions += 1;
            await this.repository.createException({
              companyId: input.companyId,
              projectId: config.projectId,
              module: config.module,
              operationId: null,
              exceptionKey: sha256(`${deterministicOperationKey(candidate)}\u001fprocessing`),
              kind: "processing_failure",
              summary: "Shadow processing stopped before cursor advancement and will reconcile again.",
              attempt: 0,
              audit: input.audit,
            });
          }
        }
      }
      run.status = "completed";
    } catch {
      run.status = "failed";
      run.exceptions += 1;
    } finally {
      await this.repository.finishRun(run);
      this.inFlightCompanies.delete(input.companyId);
    }
    return this.resultFromRun(run);
  }

  /**
   * Resolves the outline publishing binding for one config. Non-outline and
   * structurally shadow configs stay shadow-only (fail closed). A structurally
   * active outline config whose gates currently fail — kill switch, approval
   * drift, expired writer proof, or no bound MCP runtime — records one visible
   * exception and degrades this run to shadow with zero provider writes.
   */
  private async outlineBinding(
    config: ModuleConfig,
    run: ReconciliationRun,
  ): Promise<OutlineActivationBinding | null> {
    if (config.module !== "outline" || !this.outlineRuntime) return null;
    const resolved = this.outlineRuntime.resolve(config);
    if (!resolved) return null;
    if ("deniedCode" in resolved) {
      run.exceptions += 1;
      await this.repository.createException({
        companyId: config.companyId,
        projectId: config.projectId,
        module: config.module,
        operationId: null,
        exceptionKey: sha256([
          config.companyId,
          config.projectId,
          config.module,
          config.policyVersion,
          "activation-denied",
          resolved.deniedCode,
        ].join("")),
        kind: resolved.deniedCode,
        summary: `Outline publishing is denied (${resolved.deniedCode}); reconciliation stayed shadow-only with zero provider writes.`,
        attempt: 0,
        audit: {
          actorType: "plugin",
          actorId: null,
          runId: null,
        },
      });
      return null;
    }
    run.mode = "active";
    return resolved;
  }

  async replay(input: {
    companyId: string;
    operationId: string;
    audit: AuditIdentity;
  }): Promise<ReconcileResult> {
    const operation = await this.repository.getOperation(input.companyId, input.operationId);
    if (!operation) {
      throw new WorkflowRequestError(
        404,
        "operation_not_found",
        "Operation not found in the authorized company",
        "Operation not found",
      );
    }
    const configs = await this.repository.listConfigs(input.companyId);
    const config = configs.find((candidate) =>
      candidate.projectId === operation.projectId && candidate.module === operation.module);
    if (!config) throw new Error("Operation configuration no longer exists");

    const run = await this.repository.startRun(input.companyId, "retry", input.audit);
    const outline = await this.outlineBinding(config, run);
    if (!outline && !isOutlineActiveConfig(config)) assertShadowOnly(config);
    try {
      if (operation.status === "shadowed" || operation.status === "skipped") {
        run.scanned = 1;
        run.duplicates = 1;
        await this.repository.advanceCursor(this.candidateFromOperation(operation), operation.operationKey);
      } else if (operation.attempt >= config.maxAttempts) {
        run.scanned = 1;
        run.exceptions = 1;
        await this.repository.createException({
          companyId: operation.companyId,
          projectId: operation.projectId,
          module: operation.module,
          operationId: operation.id,
          exceptionKey: sha256(`${operation.operationKey}\u001fattempt-limit`),
          kind: "attempt_limit",
          summary: "Manual replay refused because the bounded attempt limit was reached.",
          attempt: operation.attempt,
          audit: input.audit,
        });
      } else {
        await this.repository.reopenForReplay(input.companyId, input.operationId, input.audit);
        await this.processCandidate(
          this.candidateFromOperation(operation),
          config,
          run,
          input.audit,
          true,
          outline,
        );
      }
      run.status = "completed";
    } catch {
      run.status = "failed";
      run.exceptions += 1;
    } finally {
      await this.repository.finishRun(run);
    }
    return this.resultFromRun(run);
  }

  async recordAttemptFailure(input: {
    companyId: string;
    operationId: string;
    leaseToken: string;
    failure: AttemptFailure;
    audit: AuditIdentity;
  }): Promise<void> {
    const operation = await this.repository.getOperation(input.companyId, input.operationId);
    if (!operation) {
      throw new WorkflowRequestError(
        404,
        "operation_not_found",
        "Operation not found in the authorized company",
        "Operation not found",
      );
    }
    const configs = await this.repository.listConfigs(input.companyId);
    const config = configs.find((candidate) =>
      candidate.projectId === operation.projectId && candidate.module === operation.module);
    if (!config) throw new Error("Operation configuration no longer exists");
    const decision = classifyFailure(input.failure, operation.attempt, config, this.now());
    const receipt = createRedactedReceipt({
      operationKey: operation.operationKey,
      category: decision.status === "reconciling"
        ? "reconciled"
        : decision.status === "retry_wait" ? "retry" : "exception",
      code: decision.exceptionKind,
      status: decision.status,
      occurredAt: this.now().toISOString(),
    });
    const recorded = await this.repository.recordFailure(
      input.companyId,
      input.operationId,
      input.leaseToken,
      decision,
      receipt,
    );
    if (!recorded) throw new Error("Operation lease was lost before failure recording");
    await this.repository.createException({
      companyId: operation.companyId,
      projectId: operation.projectId,
      module: operation.module,
      operationId: operation.id,
      exceptionKey: sha256(`${operation.operationKey}\u001f${decision.exceptionKind}`),
      kind: decision.exceptionKind,
      summary: "A redacted integration failure requires retry, reconciliation, or operator review.",
      attempt: operation.attempt,
      audit: input.audit,
    });
  }

  getReport(companyId: string): Promise<ShadowReport> {
    return this.repository.getReport(companyId);
  }

  private async processCandidate(
    candidate: SourceCandidate,
    config: ModuleConfig,
    run: ReconciliationRun,
    audit: AuditIdentity,
    force: boolean,
    outline: OutlineActivationBinding | null = null,
  ): Promise<void> {
    if (candidate.companyId !== config.companyId || candidate.projectId !== config.projectId) {
      throw new Error("Candidate crossed the configured company/project boundary");
    }
    run.scanned += 1;
    const operationKey = deterministicOperationKey(candidate);
    const operation = await this.repository.ensureOperation(candidate, operationKey, audit);

    if (operation.status === "shadowed" || operation.status === "skipped" || operation.status === "published") {
      await this.repository.advanceCursor(candidate, operationKey);
      run.duplicates += 1;
      return;
    }
    if (operation.status === "failed" || operation.status === "conflict") {
      run.exceptions += 1;
      return;
    }
    if (operation.attempt >= config.maxAttempts) {
      run.exceptions += 1;
      return;
    }

    const leaseToken = randomUUID();
    const claimed = await this.repository.claimOperation(
      candidate.companyId,
      operation.id,
      leaseToken,
      force,
    );
    if (!claimed) {
      run.duplicates += 1;
      return;
    }

    if (outline && isOutlineActiveConfig(config) && this.outlineRuntime) {
      const preview = await this.outlineRuntime.loadPreview(
        candidate.companyId,
        candidate.sourceId,
        config.policyVersion,
      );
      if (preview) {
        await this.publishCandidate(
          candidate, config, run, audit, operation, operationKey, leaseToken, outline, preview,
        );
        return;
      }
      // No durable material preview yet: observe in shadow. The operation
      // ledger records the observation; board replay can publish later once
      // an assessment lands.
    }

    const receipt = createRedactedReceipt({
      operationKey,
      category: "shadow",
      code: "candidate_observed",
      status: candidate.sourceStatus,
      occurredAt: this.now().toISOString(),
    });
    const completed = await this.repository.completeShadow(
      candidate.companyId,
      operation.id,
      leaseToken,
      receipt,
    );
    if (!completed) {
      run.conflicts += 1;
      await this.repository.createException({
        companyId: candidate.companyId,
        projectId: candidate.projectId,
        module: candidate.module,
        operationId: operation.id,
        exceptionKey: sha256(`${operationKey}\u001flease-lost`),
        kind: "lease_lost",
        summary: "Operation lease changed before the shadow receipt was committed.",
        attempt: operation.attempt + 1,
        audit,
      });
      return;
    }

    // Deliberately after the durable terminal ledger update. A crash here only
    // causes overlap replay, which is absorbed by the deterministic key.
    await this.repository.advanceCursor(candidate, operationKey);
    run.shadowed += 1;
  }

  /**
   * Active-path candidate processing: publish the durable preview through the
   * guarded publisher and translate its receipt into the durable ledger.
   * Publish denials (kill switch, approval drift, expiry) make zero provider
   * calls and degrade to a shadow observation plus a visible exception.
   */
  private async publishCandidate(
    candidate: SourceCandidate,
    config: ModuleConfig,
    run: ReconciliationRun,
    audit: AuditIdentity,
    operation: OperationRecord,
    operationKey: string,
    leaseToken: string,
    outline: OutlineActivationBinding,
    preview: OutlineShadowPreview,
  ): Promise<void> {
    let receipt: OutlinePublishReceipt;
    try {
      receipt = await publishOutlinePreview({
        preview,
        destination: outline.destination,
        authorization: outline.authorization,
        api: outline.api,
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof OutlinePublishingDeniedError) {
        await this.completeAsDeniedShadow(
          candidate, run, audit, operation, operationKey, leaseToken, error.code,
        );
        return;
      }
      throw error;
    }

    const redacted = redactedPublishReceipt(operationKey, receipt);
    if (receipt.outcome === "succeeded") {
      const completed = await this.repository.completePublish(
        candidate.companyId,
        operation.id,
        leaseToken,
        redacted,
      );
      if (!completed) {
        run.conflicts += 1;
        await this.repository.createException({
          companyId: candidate.companyId,
          projectId: candidate.projectId,
          module: candidate.module,
          operationId: operation.id,
          exceptionKey: sha256([operationKey, "lease-lost"].join("\u001f")),
          kind: "lease_lost",
          summary: "Operation lease changed before the publish receipt was committed.",
          attempt: operation.attempt + 1,
          audit,
        });
        return;
      }
      // Deliberately after the durable terminal ledger update. A crash here
      // only causes overlap replay, absorbed by the deterministic identity.
      await this.repository.advanceCursor(candidate, operationKey);
      run.published += 1;
      if (receipt.action !== "already_current" || receipt.reconciledBeforeRetry) run.externalWrites += 1;
      return;
    }

    const decision = classifyFailure(
      attemptFailureFromPublishReceipt(receipt),
      operation.attempt,
      config,
      this.now(),
    );
    if (decision.status === "retry_wait" && receipt.retryAfterMs != null && receipt.retryAfterMs > 0) {
      const brokerDelay = new Date(this.now().getTime() + receipt.retryAfterMs).toISOString();
      if (!decision.retryAt || brokerDelay > decision.retryAt) decision.retryAt = brokerDelay;
    }
    const recorded = await this.repository.recordFailure(
      candidate.companyId,
      operation.id,
      leaseToken,
      decision,
      redacted,
    );
    if (!recorded) throw new Error("Operation lease was lost before failure recording");
    await this.repository.createException({
      companyId: candidate.companyId,
      projectId: candidate.projectId,
      module: candidate.module,
      operationId: operation.id,
      exceptionKey: sha256([operationKey, decision.exceptionKind].join("\u001f")),
      kind: decision.exceptionKind,
      summary: receipt.reconciledBeforeRetry
        ? "A redacted Outline publish failure was reconciled before a bounded retry."
        : "A redacted Outline publish failure requires retry or operator review.",
      attempt: operation.attempt,
      audit,
    });
    run.exceptions += 1;
  }

  private async completeAsDeniedShadow(
    candidate: SourceCandidate,
    run: ReconciliationRun,
    audit: AuditIdentity,
    operation: OperationRecord,
    operationKey: string,
    leaseToken: string,
    deniedCode: string,
  ): Promise<void> {
    const receipt = createRedactedReceipt({
      operationKey,
      category: "shadow",
      code: "candidate_observed",
      status: candidate.sourceStatus,
      occurredAt: this.now().toISOString(),
    });
    const completed = await this.repository.completeShadow(
      candidate.companyId,
      operation.id,
      leaseToken,
      receipt,
    );
    await this.repository.createException({
      companyId: candidate.companyId,
      projectId: candidate.projectId,
      module: candidate.module,
      operationId: completed ? operation.id : null,
      exceptionKey: sha256([operationKey, "publish-denied", deniedCode].join("\u001f")),
      kind: deniedCode,
      summary: `Outline publishing was denied before any provider call (${deniedCode}); the candidate was observed in shadow.`,
      attempt: operation.attempt,
      audit,
    });
    run.exceptions += 1;
    if (completed) {
      await this.repository.advanceCursor(candidate, operationKey);
      run.shadowed += 1;
    } else {
      run.conflicts += 1;
    }
  }

  private candidateFromOperation(operation: OperationRecord): SourceCandidate {
    return {
      companyId: operation.companyId,
      projectId: operation.projectId,
      module: operation.module,
      sourceKind: operation.sourceKind,
      sourceId: operation.sourceId,
      sourceVersion: operation.sourceVersion,
      policyVersion: operation.policyVersion,
      cursorValue: operation.cursorValue,
      sourceStatus: "replay",
    };
  }

  private resultFromRun(run: ReconciliationRun): ReconcileResult {
    return {
      runId: run.id,
      companyId: run.companyId,
      mode: run.mode,
      scanned: run.scanned,
      shadowed: run.shadowed,
      published: run.published,
      duplicates: run.duplicates,
      conflicts: run.conflicts,
      exceptions: run.exceptions,
      externalWrites: run.externalWrites,
    };
  }
}

function redactedPublishReceipt(operationKey: string, receipt: OutlinePublishReceipt): RedactedReceipt {
  return createRedactedReceipt({
    operationKey,
    category: receipt.outcome === "succeeded"
      ? "publish"
      : receipt.outcome === "retryable_failure" ? "retry" : "exception",
    code: receipt.outcome === "succeeded" ? `publish_${receipt.action}` : (receipt.errorClass ?? "outline_publish_failed"),
    status: receipt.outcome === "succeeded" ? receipt.action : receipt.outcome,
    occurredAt: receipt.occurredAt,
    externalWriteAttempted: receipt.outcome !== "succeeded"
      || receipt.action !== "already_current"
      || receipt.reconciledBeforeRetry,
  });
}

/**
 * Translates a guarded-publisher receipt into the shared failure classifier.
 * Ambiguous results were already reconciled by the publisher before it returns
 * a retryable receipt, so they map to a bounded provider-unavailable retry
 * rather than another reconciliation pass.
 */
function attemptFailureFromPublishReceipt(receipt: OutlinePublishReceipt): AttemptFailure {
  const code = receipt.errorClass ?? "";
  if (receipt.outcome === "terminal_failure") {
    if (/credential|auth|forbidden|revoked/.test(code)) return { httpStatus: 401 };
    if (/schema/.test(code)) return { kind: "invalid_schema" };
    return { httpStatus: 400 };
  }
  if (/rate/.test(code)) return { httpStatus: 429 };
  return { httpStatus: 503 };
}
