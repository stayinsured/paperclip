import { randomUUID } from "node:crypto";
import {
  assertShadowOnly,
  classifyFailure,
  createRedactedReceipt,
  deterministicOperationKey,
  sha256,
  type AttemptFailure,
  type AuditIdentity,
  type ModuleConfig,
  type SourceCandidate,
  WorkflowRequestError,
} from "./contracts.js";
import type {
  OperationRecord,
  ReconciliationRun,
  ShadowReport,
  WorkflowRepository,
} from "./repository.js";

export interface ReconcileResult {
  runId: string;
  companyId: string;
  mode: "shadow";
  scanned: number;
  shadowed: number;
  duplicates: number;
  conflicts: number;
  exceptions: number;
  externalWrites: 0;
}

export class ShadowReconciler {
  private readonly inFlightCompanies = new Set<string>();

  constructor(
    private readonly repository: WorkflowRepository,
    private readonly now: () => Date = () => new Date(),
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
        assertShadowOnly(config);
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
            await this.processCandidate(candidate, config, run, input.audit, false);
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
    assertShadowOnly(config);

    const run = await this.repository.startRun(input.companyId, "retry", input.audit);
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
  ): Promise<void> {
    if (candidate.companyId !== config.companyId || candidate.projectId !== config.projectId) {
      throw new Error("Candidate crossed the configured company/project boundary");
    }
    run.scanned += 1;
    const operationKey = deterministicOperationKey(candidate);
    const operation = await this.repository.ensureOperation(candidate, operationKey, audit);

    if (operation.status === "shadowed" || operation.status === "skipped") {
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
      mode: "shadow",
      scanned: run.scanned,
      shadowed: run.shadowed,
      duplicates: run.duplicates,
      conflicts: run.conflicts,
      exceptions: run.exceptions,
      externalWrites: 0,
    };
  }
}
