import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  documents,
  issueDocuments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { conflict, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { documentService } from "./documents.js";
import {
  emitSdlcLifecycleEvent,
  lifecycleEventInputForEvidenceRecord,
} from "./sdlc-observability.js";

/**
 * SDLC lifecycle gates (STA-2781, rollout task D).
 *
 * Implements the machine contracts from the STA-2780 lifecycle contracts
 * document v1.0 (sections 3-6, 10, 11) on top of native Paperclip
 * primitives: no new issue statuses, evidence records live in the
 * append-only `sdlc-evidence` issue document on the initiative root, and
 * gate decisions are bound to the plan revision (and graph revision for
 * Gate 2) they were accepted against.
 *
 * Everything here is inert for issue trees whose root carries no
 * `sdlc-evidence` classification record: guards resolve governance first
 * and return immediately when the tree is not SDLC-governed.
 */

export const SDLC_EVIDENCE_DOCUMENT_KEY = "sdlc-evidence";
export const SDLC_EMERGENCY_DOCUMENT_KEY = "sdlc-emergency";

const SDLC_MAX_PARENT_HOPS = 16;
const SDLC_MAX_DESCENDANTS = 500;
const SDLC_EVIDENCE_APPEND_ATTEMPTS = 4;

const SDLC_TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const SDLC_START_STATUSES = new Set(["todo", "in_progress"]);
const SDLC_LIVE_STATUSES = ["todo", "in_progress", "in_review", "blocked"];
const SDLC_EMERGENCY_AUTHORIZER_ROLES = new Set(["ceo", "cto"]);

export type SdlcRiskClass = "C1" | "C2" | "C3";

export type SdlcEvidenceRecord = {
  id: string;
  type: string;
  companyId: string;
  issueId: string;
  createdAt?: string;
  actorAgentId?: string | null;
  actorRunId?: string | null;
  supersedeOf?: string | null;
} & Record<string, unknown>;

export type SdlcGovernance = {
  rootIssueId: string;
  companyId: string;
  records: SdlcEvidenceRecord[];
  classification: SdlcEvidenceRecord;
};

export type SdlcMissingRow = {
  rowId: string;
  text: string;
  requiredEvidence: string;
};

export type SdlcActor = {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

function governanceRiskClass(governance: SdlcGovernance): SdlcRiskClass | null {
  const value = readRecordString(governance.classification, "class");
  return value === "C1" || value === "C2" || value === "C3" ? value : null;
}

type DbOrTx = Pick<Db, "select">;

function readRecordString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isTerminalStatus(status: string): boolean {
  return SDLC_TERMINAL_STATUSES.has(status);
}

/** Parses the JSONL body of an sdlc-evidence registry document. */
export function parseSdlcEvidenceRegistry(body: string | null | undefined): SdlcEvidenceRecord[] {
  if (!body) return [];
  const parsed: SdlcEvidenceRecord[] = [];
  for (const [index, line] of body.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const candidate = asRecord(JSON.parse(trimmed));
      if (!candidate || typeof candidate.id !== "string" || typeof candidate.type !== "string") {
        throw new Error("invalid evidence envelope");
      }
      parsed.push(candidate as SdlcEvidenceRecord);
    } catch (error) {
      throw unprocessable("SDLC evidence registry is malformed", {
        code: "sdlc_evidence_registry_malformed",
        line: index + 1,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return parsed;
}

export function serializeSdlcEvidenceRegistry(records: SdlcEvidenceRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

export function buildSdlcEvidenceRecord(
  envelope: {
    id: string;
    type: string;
    companyId: string;
    issueId: string;
    actor?: SdlcActor;
    supersedeOf?: string | null;
  },
  fields: Record<string, unknown> = {},
): SdlcEvidenceRecord {
  return {
    ...fields,
    id: envelope.id,
    type: envelope.type,
    companyId: envelope.companyId,
    issueId: envelope.issueId,
    createdAt: new Date().toISOString(),
    actorAgentId: envelope.actor?.agentId ?? null,
    actorRunId: envelope.actor?.runId ?? null,
    supersedeOf: envelope.supersedeOf ?? null,
  };
}

export async function readSdlcIssueDocument(
  dbOrTx: DbOrTx,
  issueId: string,
  key: string,
): Promise<{ body: string; latestRevisionId: string | null; createdByAgentId: string | null } | null> {
  const rows = await dbOrTx
    .select({
      latestBody: documents.latestBody,
      latestRevisionId: documents.latestRevisionId,
      createdByAgentId: documents.createdByAgentId,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    body: row.latestBody,
    latestRevisionId: row.latestRevisionId,
    createdByAgentId: row.createdByAgentId,
  };
}

/**
 * Appends records to the root sdlc-evidence registry. Idempotent by record
 * id: records whose id already exists are skipped, so retries after a
 * partial failure converge instead of duplicating (contracts 12.5/12.6).
 * Optimistic-revision conflicts retry with a fresh read.
 */
export async function appendSdlcEvidenceRecords(
  db: Db,
  rootIssueId: string,
  incoming: SdlcEvidenceRecord[],
  actor?: SdlcActor,
): Promise<{ appended: SdlcEvidenceRecord[]; skipped: SdlcEvidenceRecord[] }> {
  if (incoming.length === 0) return { appended: [], skipped: [] };
  const root = await db
    .select({ companyId: issues.companyId })
    .from(issues)
    .where(eq(issues.id, rootIssueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!root) {
    throw unprocessable("SDLC evidence root issue does not exist", {
      code: "sdlc_evidence_root_missing",
      rootIssueId,
    });
  }
  if (incoming.some((record) => record.companyId !== root.companyId)) {
    throw unprocessable("SDLC evidence records must belong to the root issue company", {
      code: "sdlc_scope_violation",
      rootIssueId,
    });
  }
  const documentsSvc = documentService(db);
  let skipped: SdlcEvidenceRecord[] = [];

  for (let attempt = 0; attempt < SDLC_EVIDENCE_APPEND_ATTEMPTS; attempt += 1) {
    const existingDoc = await readSdlcIssueDocument(db, rootIssueId, SDLC_EVIDENCE_DOCUMENT_KEY);
    const records = parseSdlcEvidenceRegistry(existingDoc?.body);
    const existingIds = new Set(records.map((record) => record.id));
    const pending = incoming.filter((record) => !existingIds.has(record.id));
    skipped = incoming.filter((record) => existingIds.has(record.id));
    if (pending.length === 0) {
      return { appended: [], skipped };
    }
    try {
      await documentsSvc.upsertIssueDocument({
        issueId: rootIssueId,
        key: SDLC_EVIDENCE_DOCUMENT_KEY,
        title: "SDLC evidence registry",
        format: "markdown",
        body: serializeSdlcEvidenceRegistry([...records, ...pending]),
        changeSummary: `Append ${pending.length} SDLC evidence record(s): ${pending.map((record) => record.type).join(", ")}`,
        baseRevisionId: existingDoc?.latestRevisionId ?? null,
        createdByAgentId: actor?.agentId ?? null,
        createdByUserId: actor?.userId ?? null,
        createdByRunId: actor?.runId ?? null,
        lockedDocumentStrategy: "conflict",
      });
      const combinedRecords = [...records, ...pending];
      const classification = [...combinedRecords]
        .reverse()
        .find((record) => record.type === "classification" && !isSuperseded(combinedRecords, record));
      const classValue = classification ? readRecordString(classification, "class") : null;
      const riskClass = classValue === "C1" || classValue === "C2" || classValue === "C3"
        ? classValue
        : null;
      for (const record of pending) {
        const eventInput = lifecycleEventInputForEvidenceRecord(record, riskClass);
        if (!eventInput) continue;
        try {
          await emitSdlcLifecycleEvent(eventInput);
        } catch {
          // Observability is best-effort and must not fail evidence writes.
        }
      }

      return { appended: pending, skipped };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRevisionConflict = message.includes("Document was updated by someone else")
        || message.includes("Document update requires baseRevisionId");
      if (!isRevisionConflict || attempt === SDLC_EVIDENCE_APPEND_ATTEMPTS - 1) {
        throw error;
      }
    }
  }
  return { appended: [], skipped };
}

function latestSdlcRecord(
  records: SdlcEvidenceRecord[],
  type: string,
  predicate?: (record: SdlcEvidenceRecord) => boolean,
): SdlcEvidenceRecord | null {
  let latest: SdlcEvidenceRecord | null = null;
  for (const record of records) {
    if (record.type !== type) continue;
    if (predicate && !predicate(record)) continue;
    if (!latest || String(record.createdAt ?? "") >= String(latest.createdAt ?? "")) {
      latest = record;
    }
  }
  return latest;
}

function isSuperseded(records: SdlcEvidenceRecord[], record: SdlcEvidenceRecord): boolean {
  return records.some((other) => other.supersedeOf === record.id);
}

/**
 * Walks the parent chain to the initiative root and resolves SDLC
 * governance from the root sdlc-evidence registry. Returns null for any
 * tree whose root carries no classification record.
 */
export async function resolveSdlcGovernance(
  dbOrTx: DbOrTx,
  issue: { id: string; companyId: string; parentId: string | null },
): Promise<SdlcGovernance | null> {
  let currentId: string | null = issue.id;
  const seen = new Set<string>();
  const chain: string[] = [];
  for (let hop = 0; hop < SDLC_MAX_PARENT_HOPS && currentId && !seen.has(currentId); hop += 1) {
    seen.add(currentId);
    const rows: Array<{ id: string; companyId: string; parentId: string | null }> = await dbOrTx
      .select({ id: issues.id, companyId: issues.companyId, parentId: issues.parentId })
      .from(issues)
      .where(eq(issues.id, currentId))
      .limit(1);
    const row: { id: string; companyId: string; parentId: string | null } | undefined = rows[0];
    if (!row) break;
    if (row.companyId !== issue.companyId) {
      // A company boundary inside one parent chain must never silently
      // trust cross-company evidence.
      return null;
    }
    chain.push(row.id);
    currentId = row.parentId;
  }
  const rootIssueId = chain[chain.length - 1];
  if (!rootIssueId) return null;
  const registryDoc = await readSdlcIssueDocument(dbOrTx, rootIssueId, SDLC_EVIDENCE_DOCUMENT_KEY);
  if (!registryDoc) return null;
  const records = parseSdlcEvidenceRegistry(registryDoc.body);
  const classification = latestSdlcRecord(records, "classification", (record) => !isSuperseded(records, record));
  if (!classification) return null;
  const classValue = readRecordString(classification, "class");
  if (classValue !== "C1" && classValue !== "C2" && classValue !== "C3") return null;
  return { rootIssueId, companyId: issue.companyId, records, classification };
}

async function readCurrentSdlcPlanRevisionId(dbOrTx: DbOrTx, rootIssueId: string): Promise<string | null> {
  const rows = await dbOrTx
    .select({ latestRevisionId: documents.latestRevisionId })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(eq(issueDocuments.issueId, rootIssueId), eq(issueDocuments.key, "plan")))
    .limit(1);
  return rows[0]?.latestRevisionId ?? null;
}

export type SdlcEmergencyRecord = {
  record: Record<string, unknown>;
  backfillOpen: boolean;
};

/**
 * Reads and validates the sdlc-emergency break-glass record on an issue
 * (contracts section 10). Valid when a CEO or CTO authorizer role and an
 * authorization timestamp are present.
 */
export async function readSdlcEmergencyRecord(
  dbOrTx: DbOrTx,
  issueId: string,
): Promise<SdlcEmergencyRecord | null> {
  const doc = await readSdlcIssueDocument(dbOrTx, issueId, SDLC_EMERGENCY_DOCUMENT_KEY);
  if (!doc) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc.body);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record) return null;
  const authorizerAgentId = readRecordString(record, "authorizerAgentId")
    ?? readRecordString(record, "authorizer");
  const authorizedAt = readRecordString(record, "authorizedAt");
  if (!authorizerAgentId || doc.createdByAgentId !== authorizerAgentId) return null;
  if (!authorizedAt || Number.isNaN(Date.parse(authorizedAt))) return null;
  const authorizer = await dbOrTx
    .select({ role: agents.role })
    .from(agents)
    .innerJoin(issues, and(eq(issues.id, issueId), eq(issues.companyId, agents.companyId)))
    .where(eq(agents.id, authorizerAgentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!authorizer || !SDLC_EMERGENCY_AUTHORIZER_ROLES.has(authorizer.role.toLowerCase())) return null;
  const backfillStatus = readRecordString(record, "backfillStatus")?.toLowerCase() ?? "open";
  return { record, backfillOpen: backfillStatus !== "closed" };
}

/** Activity logging helper; observability never fails a guarded transition. */
export async function logSdlcActivity(
  logDb: DbOrTx,
  input: {
    companyId: string;
    issueId: string;
    action: string;
    details: Record<string, unknown>;
    actor?: SdlcActor;
  },
): Promise<void> {
  try {
    await logActivity(logDb as Db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "sdlc-lifecycle",
      action: input.action,
      entityType: "issue",
      entityId: input.issueId,
      issueId: input.issueId,
      agentId: input.actor?.agentId ?? null,
      runId: input.actor?.runId ?? null,
      details: input.details,
    });
  } catch {
    // Intentionally swallowed: see docblock.
  }
  const mapped = input.action === "issue.lifecycle_transition_forbidden"
    ? { event: "lifecycle_transition_forbidden" as const, phase: "guard" as const }
    : input.action === "issue.lifecycle_emergency_used"
      ? { event: "lifecycle_emergency_used" as const, phase: "emergency" as const }
      : null;
  if (!mapped) return;
  try {
    await emitSdlcLifecycleEvent({
      ...mapped,
      companyId: input.companyId,
      issueId: input.issueId,
      riskClass: input.details.riskClass === "C1" || input.details.riskClass === "C2" || input.details.riskClass === "C3"
        ? input.details.riskClass
        : null,
      correlationId: input.actor?.runId
        ?? `${mapped.event}:${input.issueId}:${String(input.details.code ?? "observed")}`,
      actorRunId: input.actor?.runId ?? null,
      outcome: mapped.event === "lifecycle_transition_forbidden" ? "forbidden" : "used",
      errorClass: typeof input.details.code === "string" ? input.details.code : null,
    });
  } catch {
    // Intentionally swallowed: see docblock.
  }
}

function findAcceptedGateOneDecision(
  governance: SdlcGovernance,
  revisionId?: string,
): SdlcEvidenceRecord | null {
  return latestSdlcRecord(
    governance.records,
    "gate_decision",
    (record) =>
      readRecordString(record, "gate") === "gate1"
      && readRecordString(record, "verdict") === "accepted"
      && (!revisionId || readRecordString(record, "revisionId") === revisionId)
      && !isSuperseded(governance.records, record),
  );
}

function findAcceptedGateTwoDecision(governance: SdlcGovernance): SdlcEvidenceRecord | null {
  return latestSdlcRecord(
    governance.records,
    "gate_decision",
    (record) =>
      readRecordString(record, "gate") === "gate2"
      && readRecordString(record, "verdict") === "accepted"
      && !isSuperseded(governance.records, record),
  );
}

function findProvisioningComplete(governance: SdlcGovernance): SdlcEvidenceRecord | null {
  return latestSdlcRecord(
    governance.records,
    "provisioning_complete",
    (record) => !isSuperseded(governance.records, record),
  );
}

/**
 * Activation / start guard (contracts 3.4.1, 3.4.2, 6).
 *
 * Rejects any transition of a governed implementation child into todo or
 * in_progress unless Gate 2 start authorization is accepted for the
 * CURRENT plan revision and graph revision, or a valid emergency record
 * exists on the issue. Stale gate bindings reject with explicit
 * stale_plan_revision / stale_graph_rev codes.
 */
export async function assertSdlcIssueStartAllowed(
  dbOrTx: DbOrTx,
  existing: { id: string; companyId: string; parentId: string | null },
  logDb: DbOrTx,
  actor?: SdlcActor,
): Promise<void> {
  const governance = await resolveSdlcGovernance(dbOrTx, existing);
  if (!governance) return;
  // The root issue is execution coordination, not an implementation
  // child; its transitions follow the root rules instead.
  if (governance.rootIssueId === existing.id) return;

  const emergency = await readSdlcEmergencyRecord(dbOrTx, existing.id);
  if (emergency) {
    await logSdlcActivity(logDb, {
      companyId: governance.companyId,
      issueId: existing.id,
      action: "issue.lifecycle_emergency_used",
      details: {
        code: "sdlc_emergency_used",
        rootIssueId: governance.rootIssueId,
        riskClass: governanceRiskClass(governance),
        authorizerRole: readRecordString(emergency.record, "authorizerRole"),
        backfillStatus: readRecordString(emergency.record, "backfillStatus") ?? "open",
      },
      actor,
    });
    return;
  }

  const gateDecision = findAcceptedGateTwoDecision(governance);
  if (!gateDecision) {
    await logSdlcActivity(logDb, {
      companyId: governance.companyId,
      issueId: existing.id,
      action: "issue.lifecycle_transition_forbidden",
      details: {
        code: "sdlc_gate2_required",
        reason: "Gate 2 start authorization has not been accepted for this initiative",
        rootIssueId: governance.rootIssueId,
        riskClass: governanceRiskClass(governance),
        gate: "gate2",
      },
      actor,
    });
    throw conflict("SDLC Gate 2 start authorization is required before implementation work can start", {
      code: "sdlc_gate2_required",
      gate: "gate2",
      rootIssueId: governance.rootIssueId,
    });
  }

  const boundRevisionId = readRecordString(gateDecision, "revisionId");
  const currentRevisionId = await readCurrentSdlcPlanRevisionId(dbOrTx, governance.rootIssueId);
  if (!boundRevisionId || !currentRevisionId || boundRevisionId !== currentRevisionId) {
    await logSdlcActivity(logDb, {
      companyId: governance.companyId,
      issueId: existing.id,
      action: "issue.lifecycle_transition_forbidden",
      details: {
        code: "sdlc_stale_plan_revision",
        reason: "Gate 2 decision is bound to a superseded plan revision",
        rootIssueId: governance.rootIssueId,
        riskClass: governanceRiskClass(governance),
        gate: "gate2",
        boundRevisionId,
        currentRevisionId,
      },
      actor,
    });
    throw conflict("SDLC Gate 2 approval is stale: the plan has been revised since it was accepted", {
      code: "sdlc_stale_plan_revision",
      gate: "gate2",
      rootIssueId: governance.rootIssueId,
      boundRevisionId,
      currentRevisionId,
    });
  }

  const provisioning = findProvisioningComplete(governance);
  if (!provisioning) {
    await logSdlcActivity(logDb, {
      companyId: governance.companyId,
      issueId: existing.id,
      action: "issue.lifecycle_transition_forbidden",
      details: {
        code: "sdlc_provisioning_required",
        reason: "Gate 2 cannot activate work without a completed provisioned graph",
        rootIssueId: governance.rootIssueId,
        riskClass: governanceRiskClass(governance),
      },
      actor,
    });
    throw conflict("SDLC provisioning must complete before implementation work can start", {
      code: "sdlc_provisioning_required",
      rootIssueId: governance.rootIssueId,
    });
  }
  const boundGraphRev = readRecordString(gateDecision, "graphRev");
  const currentGraphRev = readRecordString(provisioning, "graphRev");
  if (!boundGraphRev || !currentGraphRev || boundGraphRev !== currentGraphRev) {
    await logSdlcActivity(logDb, {
      companyId: governance.companyId,
      issueId: existing.id,
      action: "issue.lifecycle_transition_forbidden",
      details: {
        code: "sdlc_stale_graph_rev",
        reason: "Gate 2 decision is bound to a superseded provisioned graph",
        rootIssueId: governance.rootIssueId,
        riskClass: governanceRiskClass(governance),
        gate: "gate2",
        boundGraphRev,
        currentGraphRev,
      },
      actor,
    });
    throw conflict("SDLC Gate 2 approval is stale: the provisioned task graph has changed since it was accepted", {
      code: "sdlc_stale_graph_rev",
      gate: "gate2",
      rootIssueId: governance.rootIssueId,
      boundGraphRev,
      currentGraphRev,
    });
  }
}

/** Extracts `## Acceptance Criteria` rows from an issue description. */
export function extractSdlcAcceptanceCriteriaRows(
  description: string | null | undefined,
): Array<{ rowId: string; text: string }> {
  if (!description) return [];
  const rows: Array<{ rowId: string; text: string }> = [];
  let inSection = false;
  for (const line of description.split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) {
      inSection = heading[1]?.trim().toLowerCase() === "acceptance criteria";
      continue;
    }
    if (!inSection) continue;
    const bullet = /^[-*]\s+(.*)$/.exec(line.trim());
    const text = bullet?.[1]?.trim();
    if (text) {
      rows.push({ rowId: `ac-${rows.length + 1}`, text });
    }
  }
  return rows;
}

function collectCoveredRowIds(records: SdlcEvidenceRecord[], issueId: string): Set<string> {
  const covered = new Set<string>();
  const targetsIssue = (record: SdlcEvidenceRecord) =>
    record.issueId === issueId || readRecordString(record, "childIssueId") === issueId;

  for (const record of records) {
    if (!targetsIssue(record) || isSuperseded(records, record)) continue;
    if (record.type === "waiver") {
      const rowId = readRecordString(record, "rowId");
      if (rowId) covered.add(rowId);
      const waivedRows = record.rowIds;
      if (Array.isArray(waivedRows)) {
        for (const waived of waivedRows) {
          if (typeof waived === "string") covered.add(waived);
        }
      }
      continue;
    }
    const outcome = readRecordString(record, "verdict") ?? readRecordString(record, "result");
    if (!outcome || outcome.toLowerCase() !== "pass") continue;
    const passingRows = record.rowIds ?? record.rowsPassed;
    if (Array.isArray(passingRows)) {
      for (const passed of passingRows) {
        if (typeof passed === "string") covered.add(passed);
      }
    }
  }
  return covered;
}

async function listNonTerminalDescendants(
  dbOrTx: DbOrTx,
  rootIssueId: string,
): Promise<Array<{ id: string; identifier: string | null; title: string; status: string }>> {
  const nonTerminal: Array<{ id: string; identifier: string | null; title: string; status: string }> = [];
  const visited = new Set<string>([rootIssueId]);
  let frontier = [rootIssueId];
  while (frontier.length > 0 && nonTerminal.length < SDLC_MAX_DESCENDANTS) {
    const rows = await dbOrTx
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
      })
      .from(issues)
      .where(inArray(issues.parentId, frontier));
    frontier = [];
    for (const row of rows) {
      if (visited.has(row.id)) continue;
      visited.add(row.id);
      if (!isTerminalStatus(row.status)) {
        nonTerminal.push(row);
      }
      frontier.push(row.id);
    }
  }
  return nonTerminal;
}

/**
 * Closure / DoD guard (contracts section 11; task D acceptance criterion
 * "Done is rejected with explicit missing rows").
 */
export async function assertSdlcIssueClosureAllowed(
  dbOrTx: DbOrTx,
  existing: {
    id: string;
    companyId: string;
    parentId: string | null;
    description: string | null;
    identifier: string | null;
    status: string;
  },
  logDb: DbOrTx,
  actor?: SdlcActor,
): Promise<void> {
  const governance = await resolveSdlcGovernance(dbOrTx, existing);
  if (!governance) return;

  const missingRows: SdlcMissingRow[] = [];
  const rows = extractSdlcAcceptanceCriteriaRows(existing.description);
  const covered = collectCoveredRowIds(governance.records, existing.id);
  for (const row of rows) {
    if (!covered.has(row.rowId)) {
      missingRows.push({
        rowId: row.rowId,
        text: row.text,
        requiredEvidence: "check_result | qa_verdict | uat_evidence | waiver",
      });
    }
  }

  if (governance.rootIssueId === existing.id) {
    const nonTerminal = await listNonTerminalDescendants(dbOrTx, existing.id);
    for (const descendant of nonTerminal) {
      missingRows.push({
        rowId: `descendant:${descendant.identifier ?? descendant.id}`,
        text: `${descendant.identifier ?? descendant.id} ${descendant.title} is ${descendant.status}`,
        requiredEvidence: "descendant_terminal",
      });
    }
  }

  if (existing.status === "in_review" && actor?.agentId) {
    const implementation = latestSdlcRecord(
      governance.records,
      "pr_link",
      (record) =>
        (record.issueId === existing.id || readRecordString(record, "childIssueId") === existing.id)
        && !isSuperseded(governance.records, record),
    );
    const independentVerdict = latestSdlcRecord(
      governance.records,
      "qa_verdict",
      (record) =>
        (record.issueId === existing.id || readRecordString(record, "childIssueId") === existing.id)
        && readRecordString(record, "verdict") === "pass"
        && record.actorAgentId !== actor.agentId
        && !isSuperseded(governance.records, record),
    );
    if (implementation?.actorAgentId === actor.agentId && !independentVerdict) {
      missingRows.push({
        rowId: "review:independent_approval",
        text: "The implementation agent cannot approve its own work",
        requiredEvidence: "qa_verdict | board_confirmation",
      });
    }
  }

  const emergency = await readSdlcEmergencyRecord(dbOrTx, existing.id);
  if (emergency && emergency.backfillOpen) {
    missingRows.push({
      rowId: "emergency:backfill",
      text: "Emergency record backfill is still open",
      requiredEvidence: "emergency_backfill_closed",
    });
  }

  if (missingRows.length > 0) {
    await logSdlcActivity(logDb, {
      companyId: governance.companyId,
      issueId: existing.id,
      action: "issue.lifecycle_transition_forbidden",
      details: {
        code: "sdlc_dod_incomplete",
        rootIssueId: governance.rootIssueId,
        riskClass: governanceRiskClass(governance),
        missingRows,
      },
      actor,
    });
    throw unprocessable("SDLC definition of done is not met", {
      code: "sdlc_dod_incomplete",
      rootIssueId: governance.rootIssueId,
      missingRows,
    });
  }
}

export const SDLC_DOR_REQUIRED_PLAN_SECTIONS = [
  { rowId: "dor:plan_tasks", heading: "task", label: "Tasks / DAG section" },
  { rowId: "dor:plan_acceptance_criteria", heading: "acceptance criteria", label: "Acceptance criteria section" },
] as const;

/**
 * Definition-of-Readiness validator for the root Gate 1 request
 * (contracts 3.2): a non-empty plan document at the current revision
 * containing the required sections.
 */
export async function validateSdlcDefinitionOfReadiness(
  dbOrTx: DbOrTx,
  rootIssueId: string,
): Promise<{ result: "pass" | "fail"; missingRows: SdlcMissingRow[] }> {
  const missingRows: SdlcMissingRow[] = [];
  const doc = await readSdlcIssueDocument(dbOrTx, rootIssueId, "plan");
  if (!doc) {
    return {
      result: "fail",
      missingRows: [{
        rowId: "dor:plan_document",
        text: "Plan document is missing",
        requiredEvidence: "plan_document",
      }],
    };
  }
  if (!doc.body.trim()) {
    missingRows.push({
      rowId: "dor:plan_nonempty",
      text: "Plan document is empty",
      requiredEvidence: "plan_document",
    });
  }
  const bodyLc = doc.body.toLowerCase();
  for (const section of SDLC_DOR_REQUIRED_PLAN_SECTIONS) {
    if (!bodyLc.includes(`## ${section.heading}`)) {
      missingRows.push({
        rowId: section.rowId,
        text: `Plan is missing the ${section.label}`,
        requiredEvidence: "plan_document",
      });
    }
  }
  return { result: missingRows.length === 0 ? "pass" : "fail", missingRows };
}

/**
 * Root in_progress -> in_review guard. The same native transition serves
 * both the Gate 1 request and the closure request; the closure path is
 * recognized by all-descendants-terminal, the Gate 1 path by a
 * dor_validated record for the current plan revision (or a live DoR
 * pass). Emergency records override both.
 */
export async function assertSdlcRootReviewRequestAllowed(
  dbOrTx: DbOrTx,
  existing: {
    id: string;
    companyId: string;
    parentId: string | null;
    description: string | null;
    identifier: string | null;
  },
  logDb: DbOrTx,
  actor?: SdlcActor,
): Promise<void> {
  const governance = await resolveSdlcGovernance(dbOrTx, existing);
  if (!governance || governance.rootIssueId !== existing.id) return;

  const emergency = await readSdlcEmergencyRecord(dbOrTx, existing.id);
  if (emergency) return;

  const nonTerminal = await listNonTerminalDescendants(dbOrTx, existing.id);
  if (nonTerminal.length === 0) return;

  const currentRevisionId = await readCurrentSdlcPlanRevisionId(dbOrTx, existing.id);
  const dor = latestSdlcRecord(
    governance.records,
    "dor_validated",
    (record) =>
      readRecordString(record, "revisionId") === currentRevisionId
      && readRecordString(record, "result") === "pass"
      && !isSuperseded(governance.records, record),
  );
  if (dor) return;

  const live = await validateSdlcDefinitionOfReadiness(dbOrTx, existing.id);
  const missingRows = live.missingRows.length > 0
    ? live.missingRows
    : [{
      rowId: "dor:dor_validated",
      text: "No dor_validated record for the current plan revision",
      requiredEvidence: "dor_validated",
    }];
  await logSdlcActivity(logDb, {
    companyId: governance.companyId,
    issueId: existing.id,
    action: "issue.lifecycle_transition_forbidden",
    details: {
      code: "sdlc_dor_required",
      rootIssueId: governance.rootIssueId,
      riskClass: governanceRiskClass(governance),
      missingRows,
    },
    actor,
  });
  throw conflict("SDLC definition of ready is not met for a Gate 1 or closure review request", {
    code: "sdlc_dor_required",
    rootIssueId: governance.rootIssueId,
    missingRows,
  });
}

/**
 * Single entry point wired into issue status transitions. Inert for
 * non-governed trees and for patches that do not change status.
 */
export async function assertSdlcTransitionAllowed(
  dbOrTx: DbOrTx,
  existing: {
    id: string;
    companyId: string;
    parentId: string | null;
    description: string | null;
    identifier: string | null;
    status: string;
  },
  nextStatus: string,
  logDb: DbOrTx,
  actor?: SdlcActor,
): Promise<void> {
  if (existing.status === nextStatus) return;
  if (SDLC_START_STATUSES.has(nextStatus)) {
    await assertSdlcIssueStartAllowed(dbOrTx, existing, logDb, actor);
    return;
  }
  if (nextStatus === "done") {
    await assertSdlcIssueStartAllowed(dbOrTx, existing, logDb, actor);
    await assertSdlcIssueClosureAllowed(dbOrTx, existing, logDb, actor);
    return;
  }
  if (nextStatus === "in_review") {
    await assertSdlcRootReviewRequestAllowed(dbOrTx, existing, logDb, actor);
  }
}

export type SdlcGateBinding = {
  gate: "gate1" | "gate2";
  issueId: string;
  revisionId: string;
  graphRev: number | null;
};

/**
 * Parses the gate idempotency key grammar (contracts 4.1, 4.3):
 * confirmation:{issueId}:plan:{revisionId} for Gate 1 and
 * confirmation:{issueId}:start:{revisionId}:g{graphRev} for Gate 2.
 */
export function parseSdlcGateIdempotencyKey(key: string | null | undefined): SdlcGateBinding | null {
  if (!key) return null;
  const gate1 = /^confirmation:([^:]+):plan:([0-9a-fA-F-]{36})$/.exec(key);
  if (gate1) {
    return { gate: "gate1", issueId: gate1[1], revisionId: gate1[2], graphRev: null };
  }
  const gate2 = /^confirmation:([^:]+):start:([0-9a-fA-F-]{36}):g(\d+)$/.exec(key);
  if (gate2) {
    return { gate: "gate2", issueId: gate2[1], revisionId: gate2[2], graphRev: Number(gate2[3]) };
  }
  return null;
}

export async function assertSdlcGateRequestAllowed(
  db: Db,
  issue: { id: string; companyId: string; parentId?: string | null },
  binding: SdlcGateBinding,
): Promise<SdlcGovernance | null> {
  if (binding.issueId !== issue.id) {
    throw unprocessable("SDLC gate binding must target the interaction issue", {
      code: "sdlc_gate_issue_mismatch",
      issueId: issue.id,
      boundIssueId: binding.issueId,
    });
  }
  const governance = await resolveSdlcGovernance(db, {
    id: issue.id,
    companyId: issue.companyId,
    parentId: issue.parentId ?? null,
  });
  if (!governance) return null;
  if (governance.rootIssueId !== issue.id) {
    throw unprocessable("SDLC gates must be requested on the initiative root", {
      code: "sdlc_gate_root_required",
      rootIssueId: governance.rootIssueId,
    });
  }

  const currentRevisionId = await readCurrentSdlcPlanRevisionId(db, issue.id);
  if (!currentRevisionId || currentRevisionId !== binding.revisionId) {
    throw conflict("SDLC gate request is bound to a stale plan revision", {
      code: "sdlc_stale_plan_revision",
      boundRevisionId: binding.revisionId,
      currentRevisionId,
    });
  }

  if (binding.gate === "gate1") {
    const readiness = await validateSdlcDefinitionOfReadiness(db, issue.id);
    if (readiness.result !== "pass") {
      throw unprocessable("SDLC definition of ready is not met", {
        code: "sdlc_dor_incomplete",
        missingRows: readiness.missingRows,
      });
    }
    return governance;
  }

  if (!findAcceptedGateOneDecision(governance, binding.revisionId)) {
    throw conflict("SDLC Gate 1 must be accepted for the current plan before Gate 2", {
      code: "sdlc_gate1_required",
      revisionId: binding.revisionId,
    });
  }
  const provisioning = findProvisioningComplete(governance);
  const currentGraphRev = provisioning ? readRecordString(provisioning, "graphRev") : null;
  if (binding.graphRev === null || currentGraphRev !== String(binding.graphRev)) {
    throw conflict("SDLC Gate 2 request is bound to a stale or incomplete task graph", {
      code: provisioning ? "sdlc_stale_graph_rev" : "sdlc_provisioning_required",
      boundGraphRev: binding.graphRev,
      currentGraphRev,
    });
  }
  return governance;
}

export async function recordSdlcGateRequest(
  db: Db,
  input: {
    issue: { id: string; companyId: string; parentId?: string | null };
    binding: SdlcGateBinding;
    interactionId: string;
    actor?: SdlcActor;
  },
): Promise<SdlcEvidenceRecord | null> {
  const governance = await assertSdlcGateRequestAllowed(db, input.issue, input.binding);
  if (!governance) return null;
  const records: SdlcEvidenceRecord[] = [];
  if (input.binding.gate === "gate1") {
    records.push(buildSdlcEvidenceRecord({
      id: `evd:dor:${input.issue.companyId}:${input.issue.id}:plan:${input.binding.revisionId}`,
      type: "dor_validated",
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      actor: input.actor,
    }, { revisionId: input.binding.revisionId, result: "pass", missingRows: [] }));
  }
  const request = buildSdlcEvidenceRecord({
    id: `evd:gate-request:${input.issue.companyId}:${input.issue.id}:${input.binding.gate}:${input.interactionId}`,
    type: "gate_request",
    companyId: input.issue.companyId,
    issueId: input.issue.id,
    actor: input.actor,
  }, {
    gate: input.binding.gate,
    revisionId: input.binding.revisionId,
    graphRev: input.binding.graphRev === null ? null : String(input.binding.graphRev),
    interactionId: input.interactionId,
  });
  records.push(request);
  await appendSdlcEvidenceRecords(db, input.issue.id, records, input.actor);
  return request;
}

/**
 * Records a gate_decision evidence record from an accepted or rejected
 * request_confirmation interaction. Idempotent by record id, so retried
 * acceptance handling never duplicates the decision.
 */
export async function recordSdlcGateDecision(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    binding: SdlcGateBinding;
    verdict: "accepted" | "rejected";
    confirmationToken: string;
    reason?: string | null;
    actor?: SdlcActor;
  },
): Promise<SdlcEvidenceRecord | null> {
  const issue = await db
    .select({ id: issues.id, companyId: issues.companyId, parentId: issues.parentId })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!issue || issue.companyId !== input.companyId || input.binding.issueId !== input.issueId) {
    throw unprocessable("SDLC gate decision scope does not match the initiative", {
      code: "sdlc_scope_violation",
    });
  }
  const governance = input.verdict === "accepted"
    ? await assertSdlcGateRequestAllowed(db, issue, input.binding)
    : await resolveSdlcGovernance(db, issue);
  if (!governance || governance.rootIssueId !== input.issueId) return null;
  const id = input.binding.gate === "gate1"
    ? `evd:gate1:${input.companyId}:${input.issueId}:plan:${input.binding.revisionId}`
    : `evd:gate2:${input.companyId}:${input.issueId}:start:${input.binding.revisionId}:g${input.binding.graphRev}`;
  const record = buildSdlcEvidenceRecord(
    {
      id,
      type: "gate_decision",
      companyId: input.companyId,
      issueId: input.issueId,
      actor: input.actor,
    },
    {
      gate: input.binding.gate,
      revisionId: input.binding.revisionId,
      ...(input.binding.graphRev !== null ? { graphRev: String(input.binding.graphRev) } : {}),
      verdict: input.verdict,
      ...(input.reason ? { reason: input.reason } : {}),
      confirmationToken: input.confirmationToken,
    },
  );
  const { appended } = await appendSdlcEvidenceRecords(db, input.issueId, [record], input.actor);
  return appended[0] ?? null;
}

export type SdlcProvisionedTask = {
  taskKey: string;
  childIssueId: string;
  plannedAssigneeAgentId: string;
  blockedByTaskKeys: string[];
};

export function buildSdlcTaskIdempotencyKey(rootIssueId: string, taskKey: string): string {
  return `sdlc-task:${rootIssueId}:${taskKey}`;
}

/**
 * Completes one graph provisioning revision after the existing accepted-plan
 * decomposition path has created/reused every child and the blocker edges have
 * been read back. Deterministic record ids make retries converge.
 */
export async function recordSdlcProvisioningComplete(
  db: Db,
  input: {
    companyId: string;
    rootIssueId: string;
    revisionId: string;
    graphRev: number;
    tasks: SdlcProvisionedTask[];
    actor?: SdlcActor;
  },
): Promise<SdlcEvidenceRecord> {
  const root = await db
    .select({ id: issues.id, companyId: issues.companyId, parentId: issues.parentId })
    .from(issues)
    .where(eq(issues.id, input.rootIssueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!root || root.companyId !== input.companyId) {
    throw unprocessable("SDLC provisioning root does not match the company", {
      code: "sdlc_scope_violation",
    });
  }
  const governance = await resolveSdlcGovernance(db, root);
  if (!governance || governance.rootIssueId !== root.id) {
    throw unprocessable("SDLC provisioning requires a classified initiative root", {
      code: "sdlc_classification_required",
    });
  }
  const currentRevisionId = await readCurrentSdlcPlanRevisionId(db, root.id);
  if (currentRevisionId !== input.revisionId) {
    throw conflict("SDLC provisioning is bound to a stale plan revision", {
      code: "sdlc_stale_plan_revision",
      boundRevisionId: input.revisionId,
      currentRevisionId,
    });
  }
  if (!findAcceptedGateOneDecision(governance, input.revisionId)) {
    throw conflict("SDLC Gate 1 must be accepted before task provisioning", {
      code: "sdlc_gate1_required",
      revisionId: input.revisionId,
    });
  }
  if (input.tasks.length === 0 || new Set(input.tasks.map((task) => task.taskKey)).size !== input.tasks.length) {
    throw unprocessable("SDLC provisioning tasks must have unique task keys", {
      code: "sdlc_task_keys_invalid",
    });
  }

  const childIssueIds = input.tasks.map((task) => task.childIssueId);
  const childRows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      parentId: issues.parentId,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
    })
    .from(issues)
    .where(inArray(issues.id, childIssueIds));
  if (
    childRows.length !== childIssueIds.length
    || childRows.some((child) =>
      child.companyId !== input.companyId
      || child.parentId !== input.rootIssueId
      || child.status !== "backlog"
      || child.assigneeAgentId !== null
      || child.assigneeUserId !== null)
  ) {
    throw unprocessable("SDLC-provisioned tasks must be unassigned backlog children of the initiative", {
      code: "sdlc_provisioned_children_invalid",
    });
  }
  const plannedAssigneeAgentIds = [...new Set(input.tasks.map((task) => task.plannedAssigneeAgentId))];
  const plannedAssignees = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.companyId, input.companyId),
      inArray(agents.id, plannedAssigneeAgentIds),
      inArray(agents.status, ["active", "idle", "running", "error"]),
    ));
  if (plannedAssignees.length !== plannedAssigneeAgentIds.length) {
    throw unprocessable("SDLC planned owners must be invokable agents in the initiative company", {
      code: "sdlc_planned_owner_invalid",
    });
  }

  const taskByKey = new Map(input.tasks.map((task) => [task.taskKey, task]));
  if (input.tasks.some((task) => task.blockedByTaskKeys.some((key) => !taskByKey.has(key)))) {
    throw unprocessable("SDLC task dependencies must reference provisioned task keys", {
      code: "sdlc_dependency_key_invalid",
    });
  }
  const relationRows = await db
    .select({ blockerIssueId: issueRelations.issueId, blockedIssueId: issueRelations.relatedIssueId })
    .from(issueRelations)
    .where(and(
      eq(issueRelations.companyId, input.companyId),
      eq(issueRelations.type, "blocks"),
      inArray(issueRelations.relatedIssueId, childIssueIds),
    ));
  const actualEdges = new Set(relationRows.map((row) => `${row.blockerIssueId}:${row.blockedIssueId}`));
  const expectedEdges = new Set(input.tasks.flatMap((task) => task.blockedByTaskKeys.map((blockerKey) =>
    `${taskByKey.get(blockerKey)!.childIssueId}:${task.childIssueId}`)));
  if (actualEdges.size !== expectedEdges.size || [...expectedEdges].some((edge) => !actualEdges.has(edge))) {
    throw conflict("SDLC blocker graph readback does not match the requested DAG", {
      code: "sdlc_graph_readback_mismatch",
    });
  }

  const existingProvisioning = findProvisioningComplete(governance);
  const existingGraphRev = existingProvisioning ? Number(readRecordString(existingProvisioning, "graphRev")) : null;
  if (existingGraphRev !== null && Number.isFinite(existingGraphRev) && input.graphRev < existingGraphRev) {
    throw conflict("SDLC graph revisions must be monotonic", {
      code: "sdlc_graph_revision_regression",
      currentGraphRev: existingGraphRev,
      requestedGraphRev: input.graphRev,
    });
  }
  if (existingGraphRev === input.graphRev && existingProvisioning) {
    const existingChildren = Array.isArray(existingProvisioning.children)
      ? existingProvisioning.children.filter((value): value is string => typeof value === "string")
      : [];
    const existingTaskKeys = Array.isArray(existingProvisioning.taskKeys)
      ? existingProvisioning.taskKeys.filter((value): value is string => typeof value === "string")
      : [];
    if (
      JSON.stringify(existingChildren) !== JSON.stringify(childIssueIds)
      || JSON.stringify(existingTaskKeys) !== JSON.stringify(input.tasks.map((task) => task.taskKey))
    ) {
      throw conflict("SDLC graph revision already exists with a different task set", {
        code: "sdlc_graph_revision_conflict",
        graphRev: input.graphRev,
      });
    }
    const existingWrites = new Map(
      governance.records
        .filter((record) =>
          record.type === "provisioning_write"
          && readRecordString(record, "graphRev") === String(input.graphRev)
          && !isSuperseded(governance.records, record))
        .map((record) => [readRecordString(record, "taskKey"), record]),
    );
    const graphDetailsChanged = input.tasks.some((task) => {
      const existingWrite = existingWrites.get(task.taskKey);
      const existingBlockers = Array.isArray(existingWrite?.blockedByTaskKeys)
        ? existingWrite.blockedByTaskKeys.filter((value): value is string => typeof value === "string")
        : [];
      return !existingWrite
        || readRecordString(existingWrite, "childIssueId") !== task.childIssueId
        || readRecordString(existingWrite, "plannedAssigneeAgentId") !== task.plannedAssigneeAgentId
        || JSON.stringify(existingBlockers) !== JSON.stringify(task.blockedByTaskKeys);
    });
    if (graphDetailsChanged) {
      throw conflict("SDLC graph revision already exists with different ownership or dependencies", {
        code: "sdlc_graph_revision_conflict",
        graphRev: input.graphRev,
      });
    }
  }

  const writeRecords = input.tasks.map((task) => buildSdlcEvidenceRecord({
    id: `evd:prov-write:${input.companyId}:${input.rootIssueId}:g${input.graphRev}:${task.taskKey}`,
    type: "provisioning_write",
    companyId: input.companyId,
    issueId: input.rootIssueId,
    actor: input.actor,
  }, {
    provider: "paperclip",
    op: "provision_task",
    graphRev: String(input.graphRev),
    revisionId: input.revisionId,
    taskKey: task.taskKey,
    childIssueId: task.childIssueId,
    plannedAssigneeAgentId: task.plannedAssigneeAgentId,
    blockedByTaskKeys: task.blockedByTaskKeys,
    idempotencyKey: buildSdlcTaskIdempotencyKey(input.rootIssueId, task.taskKey),
    outcome: "verified",
  }));
  const complete = buildSdlcEvidenceRecord({
    id: `evd:prov:${input.companyId}:${input.rootIssueId}:g${input.graphRev}`,
    type: "provisioning_complete",
    companyId: input.companyId,
    issueId: input.rootIssueId,
    actor: input.actor,
  }, {
    graphRev: String(input.graphRev),
    revisionId: input.revisionId,
    children: childIssueIds,
    taskKeys: input.tasks.map((task) => task.taskKey),
    mirrorPending: false,
    verifiedAt: new Date().toISOString(),
  });
  await appendSdlcEvidenceRecords(db, input.rootIssueId, [...writeRecords, complete], input.actor);
  return complete;
}

export type SdlcActivationCandidate = {
  child: {
    id: string;
    identifier: string | null;
    title: string;
    assigneeAgentId: string | null;
  };
  order: number;
};

/**
 * Gate 2 activation evaluator (contracts 4.3, 6): returns backlog children
 * of the governed root whose blockers are all terminal, whose assignee
 * holds no other live issue, and that carry no activation record yet, in
 * plan (creation) order. Pure read; the caller performs the todo PATCH
 * through the normal update path so the start guard re-validates every
 * activation (defense in depth).
 */
export async function evaluateSdlcActivationCandidates(
  dbOrTx: DbOrTx,
  rootIssueId: string,
): Promise<{ candidates: SdlcActivationCandidate[] }> {
  const rootRows = await dbOrTx
    .select({ id: issues.id, companyId: issues.companyId, parentId: issues.parentId })
    .from(issues)
    .where(eq(issues.id, rootIssueId))
    .limit(1);
  const root = rootRows[0];
  if (!root) return { candidates: [] };
  const governance = await resolveSdlcGovernance(dbOrTx, {
    id: root.id,
    companyId: root.companyId,
    parentId: root.parentId,
  });
  if (!governance || governance.rootIssueId !== rootIssueId) return { candidates: [] };

  const alreadyActivated = new Set(
    governance.records
      .filter((record) => record.type === "activation")
      .map((record) => readRecordString(record, "childIssueId"))
      .filter((value): value is string => Boolean(value)),
  );

  const provisioning = findProvisioningComplete(governance);
  if (!provisioning) return { candidates: [] };
  const currentGraphRev = readRecordString(provisioning, "graphRev");
  const plannedAssigneeByChild = new Map<string, string>();
  for (const record of governance.records) {
    if (
      record.type !== "provisioning_write"
      || readRecordString(record, "op") !== "provision_task"
      || readRecordString(record, "graphRev") !== currentGraphRev
      || isSuperseded(governance.records, record)
    ) continue;
    const childIssueId = readRecordString(record, "childIssueId");
    const plannedAssigneeAgentId = readRecordString(record, "plannedAssigneeAgentId");
    if (childIssueId && plannedAssigneeAgentId) {
      plannedAssigneeByChild.set(childIssueId, plannedAssigneeAgentId);
    }
  }
  const provisionedChildOrder = Array.isArray(provisioning.children)
    ? provisioning.children.filter((value): value is string => typeof value === "string")
    : [];
  const planOrderByChild = new Map(provisionedChildOrder.map((childIssueId, index) => [childIssueId, index + 1]));

  const children = await dbOrTx
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      assigneeAgentId: issues.assigneeAgentId,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .where(and(eq(issues.parentId, rootIssueId), eq(issues.status, "backlog")))
    .orderBy(issues.createdAt);

  children.sort((left, right) =>
    (planOrderByChild.get(left.id) ?? Number.MAX_SAFE_INTEGER)
    - (planOrderByChild.get(right.id) ?? Number.MAX_SAFE_INTEGER));

  const assigneeIds = [...new Set(
    children
      .map((child) => plannedAssigneeByChild.get(child.id) ?? child.assigneeAgentId)
      .filter((value): value is string => Boolean(value)),
  )];
  const invokableAgentIds = new Set<string>();
  if (assigneeIds.length > 0) {
    const agentRows = await dbOrTx
      .select({ id: agents.id })
      .from(agents)
      .where(and(
        eq(agents.companyId, governance.companyId),
        inArray(agents.id, assigneeIds),
        inArray(agents.status, ["active", "idle", "running", "error"]),
      ));
    for (const agent of agentRows) invokableAgentIds.add(agent.id);
  }
  const busyAgentIds = new Set<string>();
  if (assigneeIds.length > 0) {
    const liveRows = await dbOrTx
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(
        eq(issues.companyId, governance.companyId),
        inArray(issues.assigneeAgentId, assigneeIds),
        inArray(issues.status, SDLC_LIVE_STATUSES),
      ));
    for (const row of liveRows) {
      if (row.assigneeAgentId) busyAgentIds.add(row.assigneeAgentId);
    }
  }

  const claimedAgents = new Set<string>();
  const candidates: SdlcActivationCandidate[] = [];
  for (const child of children) {
    if (alreadyActivated.has(child.id)) continue;
    const plannedAssigneeAgentId = plannedAssigneeByChild.get(child.id) ?? child.assigneeAgentId;
    if (!plannedAssigneeAgentId || !invokableAgentIds.has(plannedAssigneeAgentId)) continue;
    if (busyAgentIds.has(plannedAssigneeAgentId) || claimedAgents.has(plannedAssigneeAgentId)) {
      continue;
    }
    const blockerRows = await dbOrTx
      .select({ status: issues.status })
      .from(issueRelations)
      .innerJoin(issues, eq(issues.id, issueRelations.issueId))
      .where(and(eq(issueRelations.relatedIssueId, child.id), eq(issueRelations.type, "blocks")));
    if (blockerRows.some((row) => !isTerminalStatus(row.status))) continue;
    claimedAgents.add(plannedAssigneeAgentId);
    candidates.push({
      child: {
        id: child.id,
        identifier: child.identifier,
        title: child.title,
        assigneeAgentId: plannedAssigneeAgentId,
      },
      order: planOrderByChild.get(child.id) ?? candidates.length + 1,
    });
  }
  return { candidates };
}

/** Appends activation evidence records; idempotent by record id. */
export async function recordSdlcActivations(
  db: Db,
  rootIssueId: string,
  companyId: string,
  candidates: SdlcActivationCandidate[],
  actor?: SdlcActor,
): Promise<void> {
  if (candidates.length === 0) return;
  const records = candidates.map((candidate) => buildSdlcEvidenceRecord(
    {
      id: `evd:activation:${companyId}:${candidate.child.id}:${rootIssueId}`,
      type: "activation",
      companyId,
      issueId: rootIssueId,
      actor,
    },
    {
      childIssueId: candidate.child.id,
      agentId: candidate.child.assigneeAgentId,
      order: String(candidate.order),
    },
  ));
  await appendSdlcEvidenceRecords(db, rootIssueId, records, actor);
}
