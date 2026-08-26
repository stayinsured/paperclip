import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AuditIdentity } from "../../contracts.js";
import {
  configurationFingerprint,
  freezeSentrySnapshot,
  stableSentryIdentity,
  type FrozenSentrySnapshot,
  type SanitizedSentryIssue,
  type SentryPilotConfig,
  type SentryPollWindow,
} from "./contracts.js";

export interface SentryIssueState {
  id: string;
  companyId: string;
  projectId: string;
  stableSentryIssueId: string;
  snapshot: SanitizedSentryIssue | FrozenSentrySnapshot;
  triageIssueId: string | null;
  resolvedAt: string | null;
  resolvedCount: number | null;
  currentProposalRevisionId: string | null;
  currentConfirmationId: string | null;
  remediationIssueId: string | null;
  lastNotifiedRevisionId: string | null;
  consecutiveSlackFailures: number;
}

export interface SentryPollRun {
  id: string;
  companyId: string;
  projectId: string;
  mode: SentryPollWindow["mode"];
  status: "running" | "retry_wait" | "completed" | "failed";
  windowStart: string;
  windowEnd: string;
  nextCursor: string | null;
  pageCount: number;
  observedCount: number;
  leaseToken: string;
}

export interface NotificationRecord {
  id: string;
  companyId: string;
  issueStateId: string;
  proposalRevisionId: string;
  status: "pending" | "retry_wait" | "sent" | "reconciling" | "failed";
  attempt: number;
  leaseToken: string | null;
}

export interface SentryWorkflowReport {
  companyId: string;
  generatedAt: string;
  configs: Array<{
    projectId: string;
    pollingEnabled: boolean;
    slackEnabled: boolean;
    policyVersion: string;
    configurationFingerprint: string;
  }>;
  counts: {
    triageIdentities: number;
    unresolvedTriage: number;
    notificationsSent: number;
    notificationFailures: number;
    remediationIssues: number;
  };
  recentPolls: Array<{
    id: string;
    mode: string;
    status: string;
    pageCount: number;
    observedCount: number;
    startedAt: string;
    completedAt: string | null;
    errorCode: string | null;
  }>;
}

export interface SentryWorkflowRepository {
  upsertConfig(config: SentryPilotConfig, audit: AuditIdentity): Promise<void>;
  listConfigs(companyId: string, enabledOnly?: boolean): Promise<SentryPilotConfig[]>;
  claimPollRun(config: SentryPilotConfig, now: Date, mode?: "manual"): Promise<SentryPollRun | null>;
  advancePollRun(run: SentryPollRun, nextCursor: string | null, observed: number): Promise<void>;
  completePollRun(run: SentryPollRun): Promise<void>;
  failPollRun(run: SentryPollRun, input: { code: string; retryAt: string | null }): Promise<void>;
  upsertIssue(config: SentryPilotConfig, issue: SanitizedSentryIssue, now: Date): Promise<SentryIssueState>;
  getIssueState(companyId: string, stableIssueId: string): Promise<SentryIssueState | null>;
  listIssueStates(companyId: string): Promise<SentryIssueState[]>;
  bindTriageIssue(state: SentryIssueState, triageIssueId: string): Promise<void>;
  markResolved(state: SentryIssueState, resolvedAt: string, resolvedCount: number): Promise<void>;
  markReopened(state: SentryIssueState): Promise<void>;
  bindProposal(state: SentryIssueState, revisionId: string, confirmationId: string): Promise<void>;
  bindRemediation(state: SentryIssueState, remediationIssueId: string): Promise<void>;
  claimNotification(input: {
    config: SentryPilotConfig;
    state: SentryIssueState;
    proposalRevisionId: string;
    notificationKey: string;
  }): Promise<NotificationRecord | null>;
  completeNotification(record: NotificationRecord, receipt: Record<string, unknown>): Promise<void>;
  failNotification(record: NotificationRecord, input: {
    code: string;
    retryAt: string | null;
    ambiguous: boolean;
  }): Promise<number>;
  createException(input: {
    config: SentryPilotConfig;
    state?: SentryIssueState | null;
    key: string;
    kind: string;
    summary: string;
    attempt?: number;
    audit: AuditIdentity;
  }): Promise<void>;
  getReport(companyId: string): Promise<SentryWorkflowReport>;
}

type ConfigRow = { config_json: SentryPilotConfig };
type StateRow = {
  id: string;
  company_id: string;
  project_id: string;
  stable_sentry_issue_id: string;
  sanitized_snapshot: SanitizedSentryIssue;
  triage_issue_id: string | null;
  resolved_at: string | null;
  resolved_count: number | null;
  current_proposal_revision_id: string | null;
  current_confirmation_id: string | null;
  remediation_issue_id: string | null;
  last_notified_revision_id: string | null;
  consecutive_slack_failures: number;
};

function stateFromRow(row: StateRow): SentryIssueState {
  return {
    id: row.id,
    companyId: row.company_id,
    projectId: row.project_id,
    stableSentryIssueId: row.stable_sentry_issue_id,
    snapshot: row.sanitized_snapshot,
    triageIssueId: row.triage_issue_id,
    resolvedAt: row.resolved_at,
    resolvedCount: row.resolved_count,
    currentProposalRevisionId: row.current_proposal_revision_id,
    currentConfirmationId: row.current_confirmation_id,
    remediationIssueId: row.remediation_issue_id,
    lastNotifiedRevisionId: row.last_notified_revision_id,
    consecutiveSlackFailures: row.consecutive_slack_failures,
  };
}

export class PostgresSentryWorkflowRepository implements SentryWorkflowRepository {
  private readonly namespace: string;

  constructor(private readonly db: PluginContext["db"]) {
    if (!db.namespace) throw new Error("Plugin database namespace is not available");
    this.namespace = db.namespace;
  }

  private table(name: string): string {
    return `${this.namespace}.${name}`;
  }

  async upsertConfig(config: SentryPilotConfig, audit: AuditIdentity): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.table("sentry_configs")}
       (id, company_id, project_id, polling_enabled, slack_enabled, policy_version, config_json,
        config_fingerprint, created_by_actor_type, created_by_actor_id, created_by_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
       ON CONFLICT (company_id, project_id) DO UPDATE SET
         polling_enabled = EXCLUDED.polling_enabled,
         slack_enabled = EXCLUDED.slack_enabled,
         policy_version = EXCLUDED.policy_version,
         config_json = EXCLUDED.config_json,
         config_fingerprint = EXCLUDED.config_fingerprint,
         created_by_actor_type = EXCLUDED.created_by_actor_type,
         created_by_actor_id = EXCLUDED.created_by_actor_id,
         created_by_run_id = EXCLUDED.created_by_run_id,
         updated_at = now()`,
      [
        randomUUID(), config.companyId, config.projectId, config.pollingEnabled, config.slackEnabled,
        config.policyVersion, JSON.stringify(config), configurationFingerprint(config), audit.actorType,
        audit.actorId, audit.runId,
      ],
    );
  }

  async listConfigs(companyId: string, enabledOnly = false): Promise<SentryPilotConfig[]> {
    const rows = await this.db.query<ConfigRow>(
      `SELECT config_json
       FROM ${this.table("sentry_configs")}
       WHERE company_id = $1 AND ($2::boolean = false OR polling_enabled = true)
       ORDER BY project_id`,
      [companyId, enabledOnly],
    );
    return rows.map((row) => row.config_json);
  }

  async claimPollRun(config: SentryPilotConfig, now: Date, requestedMode?: "manual"): Promise<SentryPollRun | null> {
    const active = await this.db.query<{
      id: string;
      mode: SentryPollRun["mode"];
      status: SentryPollRun["status"];
      window_start: string;
      window_end: string;
      next_cursor: string | null;
      page_count: number;
      observed_count: number;
    }>(
      `SELECT id, mode, status, window_start::text AS window_start, window_end::text AS window_end,
              next_cursor, page_count, observed_count
       FROM ${this.table("sentry_poll_runs")}
       WHERE company_id = $1 AND project_id = $2 AND status IN ('running', 'retry_wait')
         AND (lease_expires_at IS NULL OR lease_expires_at <= $3::timestamptz)
         AND (next_attempt_at IS NULL OR next_attempt_at <= $3::timestamptz)
       ORDER BY started_at ASC
       LIMIT 1`,
      [config.companyId, config.projectId, now.toISOString()],
    );
    const leaseToken = randomUUID();
    if (active[0]) {
      const claimed = await this.db.execute(
        `UPDATE ${this.table("sentry_poll_runs")}
         SET status = 'running', lease_token = $3, lease_expires_at = $4::timestamptz + interval '4 minutes',
             next_attempt_at = NULL, updated_at = now()
         WHERE company_id = $1 AND id = $2
           AND (lease_expires_at IS NULL OR lease_expires_at <= $4::timestamptz)
           AND (next_attempt_at IS NULL OR next_attempt_at <= $4::timestamptz)`,
        [config.companyId, active[0].id, leaseToken, now.toISOString()],
      );
      if (claimed.rowCount !== 1) return null;
      return {
        id: active[0].id,
        companyId: config.companyId,
        projectId: config.projectId,
        mode: active[0].mode,
        status: "running",
        windowStart: active[0].window_start,
        windowEnd: active[0].window_end,
        nextCursor: active[0].next_cursor,
        pageCount: active[0].page_count,
        observedCount: active[0].observed_count,
        leaseToken,
      };
    }

    const history = await this.db.query<{
      last_end: string | null;
      last_backscan_at: string | null;
    }>(
      `SELECT
         max(window_end)::text AS last_end,
         max(completed_at) FILTER (WHERE mode = 'daily_backscan')::text AS last_backscan_at
       FROM ${this.table("sentry_poll_runs")}
       WHERE company_id = $1 AND project_id = $2 AND status = 'completed'`,
      [config.companyId, config.projectId],
    );
    const lastEnd = history[0]?.last_end ? new Date(history[0].last_end) : null;
    const lastBackscan = history[0]?.last_backscan_at ? new Date(history[0].last_backscan_at) : null;
    const mode: SentryPollRun["mode"] = requestedMode ?? (
      !lastBackscan || now.getTime() - lastBackscan.getTime() >= 24 * 60 * 60 * 1_000
        ? "daily_backscan"
        : "incremental"
    );
    const start = mode === "daily_backscan" || mode === "manual"
      ? new Date(now.getTime() - config.dailyBackscanHours * 60 * 60 * 1_000)
      : new Date((lastEnd?.getTime() ?? now.getTime()) - config.overlapSeconds * 1_000);
    const id = randomUUID();
    const inserted = await this.db.execute(
      `INSERT INTO ${this.table("sentry_poll_runs")}
       (id, company_id, project_id, mode, status, window_start, window_end, lease_token,
        lease_expires_at)
       VALUES ($1, $2, $3, $4, 'running', $5::timestamptz, $6::timestamptz, $7,
               $6::timestamptz + interval '4 minutes')
       ON CONFLICT DO NOTHING`,
      [id, config.companyId, config.projectId, mode, start.toISOString(), now.toISOString(), leaseToken],
    );
    if (inserted.rowCount !== 1) return null;
    return {
      id,
      companyId: config.companyId,
      projectId: config.projectId,
      mode,
      status: "running",
      windowStart: start.toISOString(),
      windowEnd: now.toISOString(),
      nextCursor: null,
      pageCount: 0,
      observedCount: 0,
      leaseToken,
    };
  }

  async advancePollRun(run: SentryPollRun, nextCursor: string | null, observed: number): Promise<void> {
    const result = await this.db.execute(
      `UPDATE ${this.table("sentry_poll_runs")}
       SET next_cursor = $4, page_count = page_count + 1, observed_count = observed_count + $5,
           lease_expires_at = now() + interval '4 minutes', updated_at = now()
       WHERE company_id = $1 AND project_id = $2 AND id = $3 AND lease_token = $6`,
      [run.companyId, run.projectId, run.id, nextCursor, observed, run.leaseToken],
    );
    if (result.rowCount !== 1) throw new Error("Sentry poll lease was lost before cursor advancement");
    run.nextCursor = nextCursor;
    run.pageCount += 1;
    run.observedCount += observed;
  }

  async completePollRun(run: SentryPollRun): Promise<void> {
    const result = await this.db.execute(
      `UPDATE ${this.table("sentry_poll_runs")}
       SET status = 'completed', lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
           last_error_code = NULL, completed_at = now(), updated_at = now()
       WHERE company_id = $1 AND project_id = $2 AND id = $3 AND lease_token = $4`,
      [run.companyId, run.projectId, run.id, run.leaseToken],
    );
    if (result.rowCount !== 1) throw new Error("Sentry poll lease was lost before completion");
  }

  async failPollRun(run: SentryPollRun, input: { code: string; retryAt: string | null }): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.table("sentry_poll_runs")}
       SET status = $5, next_attempt_at = $6::timestamptz, last_error_code = $7,
           lease_token = NULL, lease_expires_at = NULL, completed_at = CASE WHEN $6::timestamptz IS NULL THEN now() ELSE NULL END,
           updated_at = now()
       WHERE company_id = $1 AND project_id = $2 AND id = $3 AND lease_token = $4`,
      [run.companyId, run.projectId, run.id, run.leaseToken, input.retryAt ? "retry_wait" : "failed", input.retryAt, input.code],
    );
  }

  private async findState(companyId: string, stableIssueId: string): Promise<SentryIssueState | null> {
    const rows = await this.db.query<StateRow>(
      `SELECT id, company_id, project_id, stable_sentry_issue_id, sanitized_snapshot, triage_issue_id,
              resolved_at::text AS resolved_at, resolved_count, current_proposal_revision_id,
              current_confirmation_id, remediation_issue_id, last_notified_revision_id,
              consecutive_slack_failures
       FROM ${this.table("sentry_issue_states")}
       WHERE company_id = $1 AND stable_sentry_issue_id = $2`,
      [companyId, stableIssueId],
    );
    return rows[0] ? stateFromRow(rows[0]) : null;
  }

  async upsertIssue(config: SentryPilotConfig, issue: SanitizedSentryIssue, now: Date): Promise<SentryIssueState> {
    await this.db.execute(
      `INSERT INTO ${this.table("sentry_issue_states")}
       (id, company_id, project_id, sentry_organization_id, sentry_project_id,
        stable_sentry_issue_id, identity_key, sanitized_snapshot, first_observed_at, last_observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $9::timestamptz)
       ON CONFLICT (company_id, sentry_organization_id, sentry_project_id, stable_sentry_issue_id)
       DO UPDATE SET sanitized_snapshot = EXCLUDED.sanitized_snapshot,
                     last_observed_at = EXCLUDED.last_observed_at, updated_at = now()`,
      [
        randomUUID(), config.companyId, config.projectId, config.sentry.organizationId,
        config.sentry.projectId, issue.stableIssueId, stableSentryIdentity(config, issue.stableIssueId),
        JSON.stringify(freezeSentrySnapshot(config, issue, now)), now.toISOString(),
      ],
    );
    const state = await this.findState(config.companyId, issue.stableIssueId);
    if (!state) throw new Error("Sentry issue state could not be read after upsert");
    return state;
  }

  getIssueState(companyId: string, stableIssueId: string): Promise<SentryIssueState | null> {
    return this.findState(companyId, stableIssueId);
  }

  async listIssueStates(companyId: string): Promise<SentryIssueState[]> {
    const rows = await this.db.query<StateRow>(
      `SELECT id, company_id, project_id, stable_sentry_issue_id, sanitized_snapshot, triage_issue_id,
              resolved_at::text AS resolved_at, resolved_count, current_proposal_revision_id,
              current_confirmation_id, remediation_issue_id, last_notified_revision_id,
              consecutive_slack_failures
       FROM ${this.table("sentry_issue_states")}
       WHERE company_id = $1
       ORDER BY last_observed_at ASC, id ASC`,
      [companyId],
    );
    return rows.map(stateFromRow);
  }

  async bindTriageIssue(state: SentryIssueState, triageIssueId: string): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.table("sentry_issue_states")}
       SET triage_issue_id = $3::uuid, updated_at = now()
       WHERE company_id = $1 AND id = $2 AND (triage_issue_id IS NULL OR triage_issue_id = $3::uuid)`,
      [state.companyId, state.id, triageIssueId],
    );
    state.triageIssueId = triageIssueId;
  }

  async markResolved(state: SentryIssueState, resolvedAt: string, resolvedCount: number): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.table("sentry_issue_states")}
       SET resolved_at = $3::timestamptz, resolved_count = $4, updated_at = now()
       WHERE company_id = $1 AND id = $2`,
      [state.companyId, state.id, resolvedAt, resolvedCount],
    );
    state.resolvedAt = resolvedAt;
    state.resolvedCount = resolvedCount;
  }

  async markReopened(state: SentryIssueState): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.table("sentry_issue_states")}
       SET resolved_at = NULL, resolved_count = NULL, current_proposal_revision_id = NULL,
           current_confirmation_id = NULL, remediation_issue_id = NULL, updated_at = now()
       WHERE company_id = $1 AND id = $2`,
      [state.companyId, state.id],
    );
    state.resolvedAt = null;
    state.resolvedCount = null;
    state.currentProposalRevisionId = null;
    state.currentConfirmationId = null;
    state.remediationIssueId = null;
  }

  async bindProposal(state: SentryIssueState, revisionId: string, confirmationId: string): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.table("sentry_issue_states")}
       SET current_proposal_revision_id = $3::uuid, current_confirmation_id = $4::uuid, updated_at = now()
       WHERE company_id = $1 AND id = $2`,
      [state.companyId, state.id, revisionId, confirmationId],
    );
    state.currentProposalRevisionId = revisionId;
    state.currentConfirmationId = confirmationId;
  }

  async bindRemediation(state: SentryIssueState, remediationIssueId: string): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.table("sentry_issue_states")}
       SET remediation_issue_id = $3::uuid, updated_at = now()
       WHERE company_id = $1 AND id = $2 AND remediation_issue_id IS NULL`,
      [state.companyId, state.id, remediationIssueId],
    );
    state.remediationIssueId = remediationIssueId;
  }

  async claimNotification(input: {
    config: SentryPilotConfig;
    state: SentryIssueState;
    proposalRevisionId: string;
    notificationKey: string;
  }): Promise<NotificationRecord | null> {
    const id = randomUUID();
    await this.db.execute(
      `INSERT INTO ${this.table("sentry_notifications")}
       (id, company_id, project_id, sentry_issue_state_id, triage_issue_id, proposal_revision_id,
        notification_key, team_id, channel_id, status)
       VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, $7, $8, $9, 'pending')
       ON CONFLICT (company_id, notification_key) DO NOTHING`,
      [
        id, input.config.companyId, input.config.projectId, input.state.id, input.state.triageIssueId,
        input.proposalRevisionId, input.notificationKey, input.config.slack.teamId, input.config.slack.channelId,
      ],
    );
    const rows = await this.db.query<{
      id: string;
      company_id: string;
      sentry_issue_state_id: string;
      proposal_revision_id: string;
      status: NotificationRecord["status"];
      attempt: number;
      next_attempt_at: string | null;
      lease_expires_at: string | null;
    }>(
      `SELECT id, company_id, sentry_issue_state_id, proposal_revision_id, status, attempt,
              next_attempt_at::text AS next_attempt_at, lease_expires_at::text AS lease_expires_at
       FROM ${this.table("sentry_notifications")}
       WHERE company_id = $1 AND notification_key = $2`,
      [input.config.companyId, input.notificationKey],
    );
    const row = rows[0];
    if (!row || ["sent", "reconciling", "failed"].includes(row.status)) return null;
    const now = Date.now();
    if (row.next_attempt_at && Date.parse(row.next_attempt_at) > now) return null;
    if (row.lease_expires_at && Date.parse(row.lease_expires_at) > now) return null;
    const leaseToken = randomUUID();
    const claimed = await this.db.execute(
      `UPDATE ${this.table("sentry_notifications")}
       SET lease_token = $3, lease_expires_at = now() + interval '2 minutes', attempt = attempt + 1,
           status = 'pending', next_attempt_at = NULL, updated_at = now()
       WHERE company_id = $1 AND id = $2 AND status IN ('pending', 'retry_wait')
         AND (lease_expires_at IS NULL OR lease_expires_at <= now())
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())`,
      [input.config.companyId, row.id, leaseToken],
    );
    if (claimed.rowCount !== 1) return null;
    return {
      id: row.id,
      companyId: row.company_id,
      issueStateId: row.sentry_issue_state_id,
      proposalRevisionId: row.proposal_revision_id,
      status: "pending",
      attempt: row.attempt + 1,
      leaseToken,
    };
  }

  async completeNotification(record: NotificationRecord, receipt: Record<string, unknown>): Promise<void> {
    const completed = await this.db.execute(
      `UPDATE ${this.table("sentry_notifications")}
       SET status = 'sent', outcome_receipt = $4::jsonb, lease_token = NULL, lease_expires_at = NULL,
           next_attempt_at = NULL, updated_at = now()
       WHERE company_id = $1 AND id = $2 AND lease_token = $3`,
      [record.companyId, record.id, record.leaseToken, JSON.stringify(receipt)],
    );
    if (completed.rowCount !== 1) {
      throw new Error("Slack notification lease was lost before receipt commit");
    }
    await this.db.execute(
      `UPDATE ${this.table("sentry_issue_states")}
       SET last_notified_revision_id = $3::uuid, consecutive_slack_failures = 0, updated_at = now()
       WHERE company_id = $1 AND id = $2`,
      [record.companyId, record.issueStateId, record.proposalRevisionId],
    );
  }

  async failNotification(record: NotificationRecord, input: {
    code: string;
    retryAt: string | null;
    ambiguous: boolean;
  }): Promise<number> {
    const status = input.ambiguous ? "reconciling" : input.retryAt ? "retry_wait" : "failed";
    const failed = await this.db.execute(
      `UPDATE ${this.table("sentry_notifications")}
       SET status = $4, next_attempt_at = $5::timestamptz,
           outcome_receipt = $6::jsonb, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE company_id = $1 AND id = $2 AND lease_token = $3`,
      [
        record.companyId, record.id, record.leaseToken, status, input.retryAt,
        JSON.stringify({ schemaVersion: 1, code: input.code, ambiguous: input.ambiguous, externalWriteOutcome: "unknown_or_failed" }),
      ],
    );
    if (failed.rowCount !== 1) {
      const current = await this.db.query<{ consecutive_slack_failures: number }>(
        `SELECT consecutive_slack_failures
         FROM ${this.table("sentry_issue_states")}
         WHERE company_id = $1 AND id = $2`,
        [record.companyId, record.issueStateId],
      );
      return current[0]?.consecutive_slack_failures ?? 0;
    }
    const rows = await this.db.query<{ consecutive_slack_failures: number }>(
      `UPDATE ${this.table("sentry_issue_states")}
       SET consecutive_slack_failures = consecutive_slack_failures + 1, updated_at = now()
       WHERE company_id = $1 AND id = $2
       RETURNING consecutive_slack_failures`,
      [record.companyId, record.issueStateId],
    );
    return rows[0]?.consecutive_slack_failures ?? 0;
  }

  async createException(input: {
    config: SentryPilotConfig;
    state?: SentryIssueState | null;
    key: string;
    kind: string;
    summary: string;
    attempt?: number;
    audit: AuditIdentity;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.table("exceptions")}
       (id, company_id, project_id, module, operation_id, exception_key, kind, summary_redacted,
        attempt, created_by_actor_type, created_by_actor_id, created_by_run_id)
       VALUES ($1, $2, $3, 'sentry_slack', NULL, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (company_id, exception_key) DO UPDATE SET
         status = 'open', kind = EXCLUDED.kind, summary_redacted = EXCLUDED.summary_redacted,
         attempt = EXCLUDED.attempt, updated_at = now()`,
      [
        randomUUID(), input.config.companyId, input.config.projectId, input.key, input.kind,
        input.summary, input.attempt ?? 0, input.audit.actorType, input.audit.actorId, input.audit.runId,
      ],
    );
  }

  async getReport(companyId: string): Promise<SentryWorkflowReport> {
    const [configs, counts, polls] = await Promise.all([
      this.db.query<{
        project_id: string;
        polling_enabled: boolean;
        slack_enabled: boolean;
        policy_version: string;
        config_fingerprint: string;
      }>(
        `SELECT project_id, polling_enabled, slack_enabled, policy_version, config_fingerprint
         FROM ${this.table("sentry_configs")} WHERE company_id = $1 ORDER BY project_id`,
        [companyId],
      ),
      this.db.query<{
        triage_identities: number;
        unresolved_triage: number;
        notifications_sent: number;
        notification_failures: number;
        remediation_issues: number;
      }>(
        `SELECT
           count(*)::int AS triage_identities,
           count(*) FILTER (WHERE s.resolved_at IS NULL)::int AS unresolved_triage,
           (SELECT count(*)::int FROM ${this.table("sentry_notifications")} n WHERE n.company_id = $1 AND n.status = 'sent') AS notifications_sent,
           (SELECT count(*)::int FROM ${this.table("sentry_notifications")} n WHERE n.company_id = $1 AND n.status IN ('failed', 'reconciling')) AS notification_failures,
           count(*) FILTER (WHERE s.remediation_issue_id IS NOT NULL)::int AS remediation_issues
         FROM ${this.table("sentry_issue_states")} s WHERE s.company_id = $1`,
        [companyId],
      ),
      this.db.query<{
        id: string;
        mode: string;
        status: string;
        page_count: number;
        observed_count: number;
        started_at: string;
        completed_at: string | null;
        last_error_code: string | null;
      }>(
        `SELECT id, mode, status, page_count, observed_count, started_at::text AS started_at,
                completed_at::text AS completed_at, last_error_code
         FROM ${this.table("sentry_poll_runs")}
         WHERE company_id = $1 ORDER BY started_at DESC LIMIT 25`,
        [companyId],
      ),
    ]);
    const count = counts[0] ?? {
      triage_identities: 0,
      unresolved_triage: 0,
      notifications_sent: 0,
      notification_failures: 0,
      remediation_issues: 0,
    };
    return {
      companyId,
      generatedAt: new Date().toISOString(),
      configs: configs.map((row) => ({
        projectId: row.project_id,
        pollingEnabled: row.polling_enabled,
        slackEnabled: row.slack_enabled,
        policyVersion: row.policy_version,
        configurationFingerprint: row.config_fingerprint,
      })),
      counts: {
        triageIdentities: count.triage_identities,
        unresolvedTriage: count.unresolved_triage,
        notificationsSent: count.notifications_sent,
        notificationFailures: count.notification_failures,
        remediationIssues: count.remediation_issues,
      },
      recentPolls: polls.map((row) => ({
        id: row.id,
        mode: row.mode,
        status: row.status,
        pageCount: row.page_count,
        observedCount: row.observed_count,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        errorCode: row.last_error_code,
      })),
    };
  }
}
