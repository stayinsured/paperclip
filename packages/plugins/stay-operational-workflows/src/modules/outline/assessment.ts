import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AuditIdentity } from "../../contracts.js";
import { outlineAssessmentKey } from "./identity.js";
import { redactOutlineText, renderOutlineShadowPreview } from "./preview.js";
import type {
  OutlineCompletionSource,
  OutlineDestinationConfig,
  OutlineMaterialityAssessment,
  OutlineShadowPreview,
} from "./types.js";

export type OutlineAssessmentTrigger = "event" | "schedule" | "manual" | "retry";
export type OutlineAssessmentStatus = "pending" | "material" | "not_material" | "needs_review";

export interface OutlineAssessmentRecord {
  id: string;
  companyId: string;
  projectId: string;
  sourceIssueId: string;
  policyVersion: string;
  assessmentKey: string;
  status: OutlineAssessmentStatus;
  assessment: OutlineMaterialityAssessment | null;
  preview: OutlineShadowPreview | null;
  attempt: number;
  observationCount: number;
  requestedAt: string;
  assessedAt: string | null;
}

export interface OutlineMaterialityPort {
  assess(input: { source: OutlineCompletionSource; policyVersion: string; trigger: OutlineAssessmentTrigger }): Promise<OutlineMaterialityAssessment>;
}

export interface OutlineAssessmentRepository {
  acquire(input: { companyId: string; projectId: string; sourceIssueId: string; policyVersion: string; assessmentKey: string; leaseToken: string; leaseSeconds: number; audit: AuditIdentity }): Promise<{ record: OutlineAssessmentRecord; acquired: boolean }>;
  complete(input: { companyId: string; assessmentId: string; leaseToken: string; status: Exclude<OutlineAssessmentStatus, "pending">; assessment: OutlineMaterialityAssessment; preview: OutlineShadowPreview | null }): Promise<boolean>;
  release(input: { companyId: string; assessmentId: string; leaseToken: string; errorCode: string }): Promise<boolean>;
  get(companyId: string, sourceIssueId: string, policyVersion: string): Promise<OutlineAssessmentRecord | null>;
  getOldestUnassessedAgeMs(companyId: string, now: Date): Promise<number | null>;
}

export interface OutlineAssessmentResult {
  outcome: "assessed" | "already_assessed" | "coalesced";
  record: OutlineAssessmentRecord;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^outline_[a-z0-9_]{1,100}$/.test(error.message)) return error.message;
  return "outline_materiality_assessment_failed";
}

function sanitizeAssessment(assessment: OutlineMaterialityAssessment): OutlineMaterialityAssessment {
  return {
    ...assessment,
    canonicalIdentity: {
      ...assessment.canonicalIdentity,
      existingDocumentRef: assessment.canonicalIdentity.existingDocumentRef
        ? redactOutlineText(assessment.canonicalIdentity.existingDocumentRef)
        : null,
    },
    evidence: assessment.evidence.map((item) => ({
      kind: item.kind,
      sourceRef: redactOutlineText(item.sourceRef),
      claim: redactOutlineText(item.claim),
    })),
    safeDraft: assessment.safeDraft ? {
      template: assessment.safeDraft.template,
      title: redactOutlineText(assessment.safeDraft.title),
      bodyMarkdown: redactOutlineText(assessment.safeDraft.bodyMarkdown),
    } : null,
    review: { ...assessment.review, questions: assessment.review.questions.map(redactOutlineText) },
  };
}

export class OutlineAssessmentCoordinator {
  constructor(private readonly repository: OutlineAssessmentRepository, private readonly materiality: OutlineMaterialityPort, private readonly now: () => Date = () => new Date(), private readonly leaseSeconds = 120) {}

  async assessCompletion(input: { projectId: string; source: OutlineCompletionSource; destination: OutlineDestinationConfig; policyVersion: string; trigger: OutlineAssessmentTrigger; audit: AuditIdentity }): Promise<OutlineAssessmentResult> {
    if (!Number.isFinite(Date.parse(input.source.completedAt))) throw new Error("outline_source_completion_timestamp_invalid");
    const assessmentKey = outlineAssessmentKey(input.source.companyId, input.source.issueId, input.policyVersion);
    const leaseToken = randomUUID();
    const claim = await this.repository.acquire({ companyId: input.source.companyId, projectId: input.projectId, sourceIssueId: input.source.issueId, policyVersion: input.policyVersion, assessmentKey, leaseToken, leaseSeconds: this.leaseSeconds, audit: input.audit });
    if (claim.record.status !== "pending") return { outcome: "already_assessed", record: claim.record };
    if (!claim.acquired) return { outcome: "coalesced", record: claim.record };
    try {
      const assessment = await this.materiality.assess({ source: input.source, policyVersion: input.policyVersion, trigger: input.trigger });
      const preview = renderOutlineShadowPreview({ source: input.source, assessment, destination: input.destination, policyVersion: input.policyVersion, generatedAt: this.now() });
      const sanitizedAssessment = sanitizeAssessment(assessment);
      const completed = await this.repository.complete({ companyId: input.source.companyId, assessmentId: claim.record.id, leaseToken, status: assessment.classification, assessment: sanitizedAssessment, preview });
      if (!completed) throw new Error("outline_assessment_lease_lost");
      const record = await this.repository.get(input.source.companyId, input.source.issueId, input.policyVersion);
      if (!record) throw new Error("outline_assessment_readback_missing");
      return { outcome: "assessed", record };
    } catch (error) {
      await this.repository.release({ companyId: input.source.companyId, assessmentId: claim.record.id, leaseToken, errorCode: safeErrorCode(error) });
      throw error;
    }
  }
}

type AssessmentRow = { id: string; company_id: string; project_id: string; source_issue_id: string; policy_version: string; assessment_key: string; status: OutlineAssessmentStatus; assessment: OutlineMaterialityAssessment | null; preview: OutlineShadowPreview | null; attempt: number; observation_count: number; requested_at: string; assessed_at: string | null };

function fromRow(row: AssessmentRow): OutlineAssessmentRecord {
  return { id: row.id, companyId: row.company_id, projectId: row.project_id, sourceIssueId: row.source_issue_id, policyVersion: row.policy_version, assessmentKey: row.assessment_key, status: row.status, assessment: row.assessment, preview: row.preview, attempt: row.attempt, observationCount: row.observation_count, requestedAt: row.requested_at, assessedAt: row.assessed_at };
}

const SELECT_FIELDS = `id, company_id, project_id, source_issue_id, policy_version, assessment_key, status, assessment, preview, attempt, observation_count, requested_at::text AS requested_at, assessed_at::text AS assessed_at`;

export class PostgresOutlineAssessmentRepository implements OutlineAssessmentRepository {
  private readonly namespace: string;
  constructor(private readonly db: PluginContext["db"]) { if (!db.namespace) throw new Error("Plugin database namespace is not available"); this.namespace = db.namespace; }
  private table(): string { return `${this.namespace}.outline_assessments`; }

  async acquire(input: { companyId: string; projectId: string; sourceIssueId: string; policyVersion: string; assessmentKey: string; leaseToken: string; leaseSeconds: number; audit: AuditIdentity }): Promise<{ record: OutlineAssessmentRecord; acquired: boolean }> {
    await this.db.execute(`INSERT INTO ${this.table()} (id, company_id, project_id, source_issue_id, policy_version, assessment_key, created_by_actor_type, created_by_actor_id, created_by_run_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (company_id, source_issue_id, policy_version) DO UPDATE SET observation_count = ${this.table()}.observation_count + 1, updated_at = now()`, [randomUUID(), input.companyId, input.projectId, input.sourceIssueId, input.policyVersion, input.assessmentKey, input.audit.actorType, input.audit.actorId, input.audit.runId]);
    const claim = await this.db.execute(`UPDATE ${this.table()} SET lease_token=$4, lease_expires_at=now()+($5::int*interval '1 second'), attempt=attempt+1, updated_at=now() WHERE company_id=$1 AND source_issue_id=$2 AND policy_version=$3 AND status='pending' AND (lease_expires_at IS NULL OR lease_expires_at<=now())`, [input.companyId, input.sourceIssueId, input.policyVersion, input.leaseToken, input.leaseSeconds]);
    const record = await this.get(input.companyId, input.sourceIssueId, input.policyVersion);
    if (!record) throw new Error("outline_assessment_insert_readback_missing");
    return { record, acquired: claim.rowCount === 1 };
  }

  async complete(input: { companyId: string; assessmentId: string; leaseToken: string; status: Exclude<OutlineAssessmentStatus, "pending">; assessment: OutlineMaterialityAssessment; preview: OutlineShadowPreview | null }): Promise<boolean> {
    const result = await this.db.execute(`UPDATE ${this.table()} SET status=$4, assessment=$5::jsonb, preview=$6::jsonb, assessed_at=now(), lease_token=NULL, lease_expires_at=NULL, last_error_code=NULL, updated_at=now() WHERE company_id=$1 AND id=$2 AND lease_token=$3 AND status='pending'`, [input.companyId, input.assessmentId, input.leaseToken, input.status, JSON.stringify(input.assessment), input.preview ? JSON.stringify(input.preview) : null]);
    return result.rowCount === 1;
  }

  async release(input: { companyId: string; assessmentId: string; leaseToken: string; errorCode: string }): Promise<boolean> {
    const result = await this.db.execute(`UPDATE ${this.table()} SET lease_token=NULL, lease_expires_at=NULL, last_error_code=$4, updated_at=now() WHERE company_id=$1 AND id=$2 AND lease_token=$3 AND status='pending'`, [input.companyId, input.assessmentId, input.leaseToken, input.errorCode]);
    return result.rowCount === 1;
  }

  async get(companyId: string, sourceIssueId: string, policyVersion: string): Promise<OutlineAssessmentRecord | null> {
    const rows = await this.db.query<AssessmentRow>(`SELECT ${SELECT_FIELDS} FROM ${this.table()} WHERE company_id=$1 AND source_issue_id=$2 AND policy_version=$3`, [companyId, sourceIssueId, policyVersion]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async getOldestUnassessedAgeMs(companyId: string, now: Date): Promise<number | null> {
    const rows = await this.db.query<{ requested_at: string | null }>(`SELECT min(requested_at)::text AS requested_at FROM ${this.table()} WHERE company_id=$1 AND status='pending'`, [companyId]);
    const requestedAt = rows[0]?.requested_at;
    if (!requestedAt) return null;
    const timestamp = Date.parse(requestedAt);
    return Number.isFinite(timestamp) ? Math.max(0, now.getTime() - timestamp) : null;
  }
}
