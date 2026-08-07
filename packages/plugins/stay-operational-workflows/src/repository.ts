import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  candidateFromIssueRow,
  outcomeIdentity,
  type AuditIdentity,
  type ModuleConfig,
  type OperationStatus,
  type RedactedReceipt,
  type RetryDecision,
  type SourceCandidate,
  type WorkflowModule,
} from "./contracts.js";

export interface OperationRecord {
  id: string;
  companyId: string;
  projectId: string;
  module: WorkflowModule;
  operationKey: string;
  sourceKind: SourceCandidate["sourceKind"];
  sourceId: string;
  sourceVersion: string;
  policyVersion: string;
  attempt: number;
  status: OperationStatus;
  outcomeIdentity: string;
  outcomeReceipt: RedactedReceipt | Record<string, never>;
  nextAttemptAt: string | null;
  cursorValue: string;
}

export interface ReconciliationCounts {
  scanned: number;
  shadowed: number;
  duplicates: number;
  conflicts: number;
  exceptions: number;
  externalWrites: 0;
}

export interface ReconciliationRun extends ReconciliationCounts {
  id: string;
  companyId: string;
  trigger: "schedule" | "event" | "manual" | "retry";
  status: "running" | "completed" | "failed";
}

export interface ShadowReport {
  companyId: string;
  generatedAt: string;
  mode: "shadow";
  externalWrites: 0;
  modules: Array<{
    projectId: string;
    module: WorkflowModule;
    enabled: boolean;
    readOnly: boolean;
    destinationEnabled: boolean;
    destinationKey: string | null;
    sourceVersion: string;
    policyVersion: string;
  }>;
  operations: Array<{
    module: WorkflowModule;
    status: OperationStatus;
    count: number;
    maxAttempt: number;
  }>;
  exceptions: Array<{
    id: string;
    module: WorkflowModule;
    operationId: string | null;
    kind: string;
    summary: string;
    attempt: number;
    createdAt: string;
  }>;
  recentRuns: Array<{
    id: string;
    trigger: string;
    status: string;
    scanned: number;
    shadowed: number;
    duplicates: number;
    conflicts: number;
    exceptions: number;
    externalWrites: number;
    startedAt: string;
    completedAt: string | null;
  }>;
}

export interface WorkflowRepository {
  upsertConfig(config: ModuleConfig, audit: AuditIdentity): Promise<void>;
  listConfigs(companyId: string, enabledOnly?: boolean): Promise<ModuleConfig[]>;
  listIssueCandidates(config: ModuleConfig, sourceId?: string): Promise<SourceCandidate[]>;
  ensureOperation(candidate: SourceCandidate, operationKey: string, audit: AuditIdentity): Promise<OperationRecord>;
  getOperation(companyId: string, operationId: string): Promise<OperationRecord | null>;
  claimOperation(companyId: string, operationId: string, leaseToken: string, force: boolean): Promise<boolean>;
  completeShadow(companyId: string, operationId: string, leaseToken: string, receipt: RedactedReceipt): Promise<boolean>;
  recordFailure(
    companyId: string,
    operationId: string,
    leaseToken: string,
    decision: RetryDecision,
    receipt: RedactedReceipt,
  ): Promise<boolean>;
  advanceCursor(candidate: SourceCandidate, operationKey: string): Promise<void>;
  reopenForReplay(companyId: string, operationId: string, audit: AuditIdentity): Promise<boolean>;
  createException(input: {
    companyId: string;
    projectId: string;
    module: WorkflowModule;
    operationId: string | null;
    exceptionKey: string;
    kind: string;
    summary: string;
    attempt: number;
    audit: AuditIdentity;
  }): Promise<void>;
  startRun(companyId: string, trigger: ReconciliationRun["trigger"], audit: AuditIdentity): Promise<ReconciliationRun>;
  finishRun(run: ReconciliationRun): Promise<void>;
  getReport(companyId: string): Promise<ShadowReport>;
}

type ConfigRow = {
  company_id: string;
  project_id: string;
  module: WorkflowModule;
  enabled: boolean;
  read_only: boolean;
  destination_enabled: boolean;
  destination_key: string | null;
  source_version: string;
  policy_version: string;
  max_attempts: number;
  base_delay_ms: number;
  max_delay_ms: number;
  overlap_seconds: number;
  batch_size: number;
};

type OperationRow = {
  id: string;
  company_id: string;
  project_id: string;
  module: WorkflowModule;
  operation_key: string;
  source_kind: SourceCandidate["sourceKind"];
  source_id: string;
  source_version: string;
  policy_version: string;
  attempt: number;
  status: OperationStatus;
  outcome_identity: string;
  outcome_receipt: RedactedReceipt | Record<string, never>;
  next_attempt_at: string | null;
  cursor_value: string;
};

function configFromRow(row: ConfigRow): ModuleConfig {
  return {
    companyId: row.company_id,
    projectId: row.project_id,
    module: row.module,
    enabled: row.enabled,
    readOnly: row.read_only,
    destinationEnabled: row.destination_enabled,
    destinationKey: row.destination_key,
    sourceVersion: row.source_version,
    policyVersion: row.policy_version,
    maxAttempts: row.max_attempts,
    baseDelayMs: row.base_delay_ms,
    maxDelayMs: row.max_delay_ms,
    overlapSeconds: row.overlap_seconds,
    batchSize: row.batch_size,
  };
}

function operationFromRow(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    projectId: row.project_id,
    module: row.module,
    operationKey: row.operation_key,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    policyVersion: row.policy_version,
    attempt: row.attempt,
    status: row.status,
    outcomeIdentity: row.outcome_identity,
    outcomeReceipt: row.outcome_receipt,
    nextAttemptAt: row.next_attempt_at,
    cursorValue: row.cursor_value,
  };
}

function safeCursorTimestamp(cursorValue: string | null, overlapSeconds: number): string {
  if (!cursorValue) return "1970-01-01T00:00:00.000Z";
  const separator = cursorValue.indexOf("|");
  const parsed = new Date(separator === -1 ? cursorValue : cursorValue.slice(0, separator));
  if (Number.isNaN(parsed.getTime())) return "1970-01-01T00:00:00.000Z";
  return new Date(parsed.getTime() - overlapSeconds * 1_000).toISOString();
}

export class PostgresWorkflowRepository implements WorkflowRepository {
  private readonly namespace: string;

  constructor(private readonly db: PluginContext["db"]) {
    if (!db.namespace) throw new Error("Plugin database namespace is not available");
    this.namespace = db.namespace;
  }

  private table(name: string): string {
    return `${this.namespace}.${name}`;
  }

  async upsertConfig(config: ModuleConfig, audit: AuditIdentity): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.table("project_configs")}
       (id, company_id, project_id, module, enabled, read_only, destination_enabled, destination_key,
        source_version, policy_version, max_attempts, base_delay_ms, max_delay_ms, overlap_seconds,
        batch_size, created_by_actor_type, created_by_actor_id, created_by_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (company_id, project_id, module) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         read_only = EXCLUDED.read_only,
         destination_enabled = EXCLUDED.destination_enabled,
         destination_key = EXCLUDED.destination_key,
         source_version = EXCLUDED.source_version,
         policy_version = EXCLUDED.policy_version,
         max_attempts = EXCLUDED.max_attempts,
         base_delay_ms = EXCLUDED.base_delay_ms,
         max_delay_ms = EXCLUDED.max_delay_ms,
         overlap_seconds = EXCLUDED.overlap_seconds,
         batch_size = EXCLUDED.batch_size,
         created_by_actor_type = EXCLUDED.created_by_actor_type,
         created_by_actor_id = EXCLUDED.created_by_actor_id,
         created_by_run_id = EXCLUDED.created_by_run_id,
         updated_at = now()`,
      [
        randomUUID(), config.companyId, config.projectId, config.module, config.enabled, config.readOnly,
        config.destinationEnabled, config.destinationKey, config.sourceVersion, config.policyVersion,
        config.maxAttempts, config.baseDelayMs, config.maxDelayMs, config.overlapSeconds, config.batchSize,
        audit.actorType, audit.actorId, audit.runId,
      ],
    );
  }

  async listConfigs(companyId: string, enabledOnly = false): Promise<ModuleConfig[]> {
    const rows = await this.db.query<ConfigRow>(
      `SELECT company_id, project_id, module, enabled, read_only, destination_enabled, destination_key,
              source_version, policy_version, max_attempts, base_delay_ms, max_delay_ms,
              overlap_seconds, batch_size
       FROM ${this.table("project_configs")}
       WHERE company_id = $1 AND ($2::boolean = false OR enabled = true)
       ORDER BY project_id, module`,
      [companyId, enabledOnly],
    );
    return rows.map(configFromRow);
  }

  async listIssueCandidates(config: ModuleConfig, sourceId?: string): Promise<SourceCandidate[]> {
    const cursorRows = await this.db.query<{ cursor_value: string }>(
      `SELECT cursor_value FROM ${this.table("cursors")}
       WHERE company_id = $1 AND project_id = $2 AND module = $3 AND cursor_key = 'issues'`,
      [config.companyId, config.projectId, config.module],
    );
    const cutoff = sourceId ? "1970-01-01T00:00:00.000Z" : safeCursorTimestamp(cursorRows[0]?.cursor_value ?? null, config.overlapSeconds);
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id, company_id, project_id, status, updated_at::text AS updated_at
       FROM public.issues
       WHERE company_id = $1
         AND project_id = $2
         AND updated_at >= $3::timestamptz
         AND ($4::uuid IS NULL OR id = $4::uuid)
       ORDER BY updated_at ASC, id ASC
       LIMIT $5`,
      [config.companyId, config.projectId, cutoff, sourceId ?? null, sourceId ? 1 : config.batchSize],
    );
    return rows.map((row) => candidateFromIssueRow(row, config));
  }

  private async findOperation(companyId: string, module: WorkflowModule, operationKey: string): Promise<OperationRecord | null> {
    const rows = await this.db.query<OperationRow>(
      `SELECT id, company_id, project_id, module, operation_key, source_kind, source_id,
              source_version, policy_version, attempt, status, outcome_identity, outcome_receipt,
              next_attempt_at::text AS next_attempt_at, cursor_value
       FROM ${this.table("operations")}
       WHERE company_id = $1 AND module = $2 AND operation_key = $3`,
      [companyId, module, operationKey],
    );
    return rows[0] ? operationFromRow(rows[0]) : null;
  }

  async ensureOperation(candidate: SourceCandidate, operationKey: string, audit: AuditIdentity): Promise<OperationRecord> {
    await this.db.execute(
      `INSERT INTO ${this.table("operations")}
       (id, company_id, project_id, module, operation_key, source_kind, source_id, source_version,
        policy_version, status, outcome_identity, cursor_value, created_by_actor_type,
        created_by_actor_id, created_by_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12, $13, $14)
       ON CONFLICT (company_id, module, operation_key) DO NOTHING`,
      [
        randomUUID(), candidate.companyId, candidate.projectId, candidate.module, operationKey,
        candidate.sourceKind, candidate.sourceId, candidate.sourceVersion, candidate.policyVersion,
        outcomeIdentity(operationKey), candidate.cursorValue, audit.actorType, audit.actorId, audit.runId,
      ],
    );
    const operation = await this.findOperation(candidate.companyId, candidate.module, operationKey);
    if (!operation) throw new Error("Durable operation ledger insert could not be read back");
    return operation;
  }

  async getOperation(companyId: string, operationId: string): Promise<OperationRecord | null> {
    const rows = await this.db.query<OperationRow>(
      `SELECT id, company_id, project_id, module, operation_key, source_kind, source_id,
              source_version, policy_version, attempt, status, outcome_identity, outcome_receipt,
              next_attempt_at::text AS next_attempt_at, cursor_value
       FROM ${this.table("operations")}
       WHERE company_id = $1 AND id = $2`,
      [companyId, operationId],
    );
    return rows[0] ? operationFromRow(rows[0]) : null;
  }

  async claimOperation(companyId: string, operationId: string, leaseToken: string, force: boolean): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE ${this.table("operations")}
       SET lease_token = $3, lease_expires_at = now() + interval '2 minutes',
           attempt = attempt + 1, status = 'pending', updated_at = now()
       WHERE company_id = $1 AND id = $2
         AND status IN ('pending', 'retry_wait', 'reconciling')
         AND (lease_expires_at IS NULL OR lease_expires_at <= now())
         AND (status <> 'reconciling' OR $4::boolean = true)
         AND ($4::boolean = true OR next_attempt_at IS NULL OR next_attempt_at <= now())`,
      [companyId, operationId, leaseToken, force],
    );
    return result.rowCount === 1;
  }

  async completeShadow(
    companyId: string,
    operationId: string,
    leaseToken: string,
    receipt: RedactedReceipt,
  ): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE ${this.table("operations")}
       SET status = 'shadowed', outcome_receipt = $4::jsonb, next_attempt_at = NULL,
           lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL, updated_at = now()
       WHERE company_id = $1 AND id = $2 AND lease_token = $3`,
      [companyId, operationId, leaseToken, JSON.stringify(receipt)],
    );
    return result.rowCount === 1;
  }

  async recordFailure(
    companyId: string,
    operationId: string,
    leaseToken: string,
    decision: RetryDecision,
    receipt: RedactedReceipt,
  ): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE ${this.table("operations")}
       SET status = $4, outcome_receipt = $5::jsonb, next_attempt_at = $6::timestamptz,
           lease_token = NULL, lease_expires_at = NULL, last_error_code = $7, updated_at = now()
       WHERE company_id = $1 AND id = $2 AND lease_token = $3`,
      [
        companyId, operationId, leaseToken, decision.status, JSON.stringify(receipt),
        decision.retryAt, decision.exceptionKind,
      ],
    );
    return result.rowCount === 1;
  }

  async advanceCursor(candidate: SourceCandidate, operationKey: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.table("cursors")}
       (id, company_id, project_id, module, cursor_key, cursor_value, source_version, last_operation_key)
       VALUES ($1, $2, $3, $4, 'issues', $5, $6, $7)
       ON CONFLICT (company_id, project_id, module, cursor_key) DO UPDATE SET
         cursor_value = EXCLUDED.cursor_value,
         source_version = EXCLUDED.source_version,
         last_operation_key = EXCLUDED.last_operation_key,
         updated_at = now()
       WHERE ${this.table("cursors")}.cursor_value < EXCLUDED.cursor_value`,
      [
        randomUUID(), candidate.companyId, candidate.projectId, candidate.module,
        candidate.cursorValue, candidate.sourceVersion, operationKey,
      ],
    );
  }

  async reopenForReplay(companyId: string, operationId: string, audit: AuditIdentity): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE ${this.table("operations")}
       SET status = CASE WHEN status = 'shadowed' THEN status ELSE 'pending' END,
           next_attempt_at = NULL, lease_token = NULL, lease_expires_at = NULL,
           created_by_actor_type = $3, created_by_actor_id = $4, created_by_run_id = $5, updated_at = now()
       WHERE company_id = $1 AND id = $2`,
      [companyId, operationId, audit.actorType, audit.actorId, audit.runId],
    );
    return result.rowCount === 1;
  }

  async createException(input: {
    companyId: string;
    projectId: string;
    module: WorkflowModule;
    operationId: string | null;
    exceptionKey: string;
    kind: string;
    summary: string;
    attempt: number;
    audit: AuditIdentity;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.table("exceptions")}
       (id, company_id, project_id, module, operation_id, exception_key, kind, summary_redacted,
        attempt, created_by_actor_type, created_by_actor_id, created_by_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (company_id, exception_key) DO UPDATE SET
         status = 'open', kind = EXCLUDED.kind, summary_redacted = EXCLUDED.summary_redacted,
         attempt = EXCLUDED.attempt, updated_at = now()`,
      [
        randomUUID(), input.companyId, input.projectId, input.module, input.operationId,
        input.exceptionKey, input.kind, input.summary, input.attempt,
        input.audit.actorType, input.audit.actorId, input.audit.runId,
      ],
    );
  }

  async startRun(
    companyId: string,
    trigger: ReconciliationRun["trigger"],
    audit: AuditIdentity,
  ): Promise<ReconciliationRun> {
    const run: ReconciliationRun = {
      id: randomUUID(),
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
    await this.db.execute(
      `INSERT INTO ${this.table("reconciliation_runs")}
       (id, company_id, trigger, status, created_by_actor_type, created_by_actor_id, created_by_run_id)
       VALUES ($1, $2, $3, 'running', $4, $5, $6)`,
      [run.id, companyId, trigger, audit.actorType, audit.actorId, audit.runId],
    );
    return run;
  }

  async finishRun(run: ReconciliationRun): Promise<void> {
    const report = {
      schemaVersion: 1,
      mode: "shadow",
      companyId: run.companyId,
      externalWrites: 0,
      counts: {
        scanned: run.scanned,
        shadowed: run.shadowed,
        duplicates: run.duplicates,
        conflicts: run.conflicts,
        exceptions: run.exceptions,
      },
    };
    await this.db.execute(
      `UPDATE ${this.table("reconciliation_runs")}
       SET status = $3, scanned_count = $4, shadowed_count = $5, duplicate_count = $6,
           conflict_count = $7, exception_count = $8, external_write_count = 0,
           report = $9::jsonb, completed_at = now(), updated_at = now()
       WHERE company_id = $1 AND id = $2`,
      [
        run.companyId, run.id, run.status, run.scanned, run.shadowed, run.duplicates,
        run.conflicts, run.exceptions, JSON.stringify(report),
      ],
    );
  }

  async getReport(companyId: string): Promise<ShadowReport> {
    const [configs, operations, exceptions, recentRuns] = await Promise.all([
      this.listConfigs(companyId),
      this.db.query<{
        module: WorkflowModule;
        status: OperationStatus;
        count: number;
        max_attempt: number;
      }>(
        `SELECT module, status, count(*)::int AS count, max(attempt)::int AS max_attempt
         FROM ${this.table("operations")}
         WHERE company_id = $1
         GROUP BY module, status
         ORDER BY module, status`,
        [companyId],
      ),
      this.db.query<{
        id: string;
        module: WorkflowModule;
        operation_id: string | null;
        kind: string;
        summary_redacted: string;
        attempt: number;
        created_at: string;
      }>(
        `SELECT id, module, operation_id, kind, summary_redacted, attempt, created_at::text AS created_at
         FROM ${this.table("exceptions")}
         WHERE company_id = $1 AND status = 'open'
         ORDER BY created_at DESC
         LIMIT 100`,
        [companyId],
      ),
      this.db.query<{
        id: string;
        trigger: string;
        status: string;
        scanned_count: number;
        shadowed_count: number;
        duplicate_count: number;
        conflict_count: number;
        exception_count: number;
        external_write_count: number;
        started_at: string;
        completed_at: string | null;
      }>(
        `SELECT id, trigger, status, scanned_count, shadowed_count, duplicate_count,
                conflict_count, exception_count, external_write_count,
                started_at::text AS started_at, completed_at::text AS completed_at
         FROM ${this.table("reconciliation_runs")}
         WHERE company_id = $1
         ORDER BY started_at DESC
         LIMIT 25`,
        [companyId],
      ),
    ]);
    return {
      companyId,
      generatedAt: new Date().toISOString(),
      mode: "shadow",
      externalWrites: 0,
      modules: configs.map((config) => ({
        projectId: config.projectId,
        module: config.module,
        enabled: config.enabled,
        readOnly: config.readOnly,
        destinationEnabled: config.destinationEnabled,
        destinationKey: config.destinationKey,
        sourceVersion: config.sourceVersion,
        policyVersion: config.policyVersion,
      })),
      operations: operations.map((row) => ({
        module: row.module,
        status: row.status,
        count: row.count,
        maxAttempt: row.max_attempt,
      })),
      exceptions: exceptions.map((row) => ({
        id: row.id,
        module: row.module,
        operationId: row.operation_id,
        kind: row.kind,
        summary: row.summary_redacted,
        attempt: row.attempt,
        createdAt: row.created_at,
      })),
      recentRuns: recentRuns.map((row) => ({
        id: row.id,
        trigger: row.trigger,
        status: row.status,
        scanned: row.scanned_count,
        shadowed: row.shadowed_count,
        duplicates: row.duplicate_count,
        conflicts: row.conflict_count,
        exceptions: row.exception_count,
        externalWrites: row.external_write_count,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      })),
    };
  }
}
