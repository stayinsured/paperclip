import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, issueDocuments, issues } from "@paperclipai/db";
import {
  INTEGRATION_RECONCILIATION_DOCUMENT_KEY,
  isIntegrationReceiptCurrentAndHealthy,
  parseIntegrationReconciliationReceipt,
} from "@paperclipai/shared";
import { conflict } from "../errors.js";

type DbOrTx = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

export type ParentIntegrationReconciliationFailure = {
  issueId: string;
  identifier: string | null;
  reason: "parent_integration_receipt_missing_or_stale" | "child_not_terminal" | "integration_receipt_missing_or_stale";
};

async function readReceiptBodies(
  dbOrTx: DbOrTx,
  companyId: string,
  issueIds: string[],
  options: { lock?: boolean } = {},
): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const query = dbOrTx
    .select({ issueId: issueDocuments.issueId, body: documents.latestBody })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(
      eq(issueDocuments.companyId, companyId),
      eq(issueDocuments.key, INTEGRATION_RECONCILIATION_DOCUMENT_KEY),
      inArray(issueDocuments.issueId, issueIds),
    ));
  const rows = options.lock ? await query.for("update") : await query;
  return new Map(rows.map((row) => [row.issueId, row.body]));
}

export function evaluateParentIntegrationReconciliationFailures(
  children: Array<{ id: string; identifier: string | null; status: string; updatedAt: Date }>,
  receiptBodies: ReadonlyMap<string, string>,
  requiredIntegrations: string[],
): ParentIntegrationReconciliationFailure[] {
  return children.flatMap((child): ParentIntegrationReconciliationFailure[] => {
    if (child.status !== "done" && child.status !== "cancelled") {
      return [{ issueId: child.id, identifier: child.identifier, reason: "child_not_terminal" }];
    }
    const healthy = isIntegrationReceiptCurrentAndHealthy({
      receipt: parseIntegrationReconciliationReceipt(receiptBodies.get(child.id)),
      issueId: child.id,
      status: child.status,
      updatedAt: child.updatedAt.toISOString(),
      requiredIntegrations,
    });
    return healthy ? [] : [{
      issueId: child.id,
      identifier: child.identifier,
      reason: "integration_receipt_missing_or_stale",
    }];
  });
}

/**
 * A task tree opts into integration-gated closure when any direct node carries
 * a reconciliation receipt. Once opted in, the parent and every direct child
 * must carry current healthy receipts for every integration named by the tree.
 */
export async function getParentIntegrationReconciliationFailures(
  dbOrTx: DbOrTx,
  parentIssueId: string,
  options: { lock?: boolean } = {},
): Promise<ParentIntegrationReconciliationFailure[]> {
  const parent = await dbOrTx
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      status: issues.status,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(eq(issues.id, parentIssueId))
    .then((rows) => rows[0] ?? null);
  if (!parent) return [];

  const childrenQuery = dbOrTx
    .select({
      id: issues.id,
      identifier: issues.identifier,
      status: issues.status,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(and(eq(issues.companyId, parent.companyId), eq(issues.parentId, parent.id)));
  const children = options.lock ? await childrenQuery.for("update") : await childrenQuery;
  const receiptBodies = await readReceiptBodies(
    dbOrTx,
    parent.companyId,
    [parent.id, ...children.map((child) => child.id)],
    options,
  );
  const parentReceipt = parseIntegrationReconciliationReceipt(receiptBodies.get(parent.id));
  const childReceipts = children.map((child) => parseIntegrationReconciliationReceipt(receiptBodies.get(child.id)));
  const requiredIntegrations = [...new Set(
    [parentReceipt, ...childReceipts].flatMap((receipt) => receipt?.requiredIntegrations ?? []),
  )].sort();
  if (requiredIntegrations.length === 0) return [];

  const parentHealthy = isIntegrationReceiptCurrentAndHealthy({
    receipt: parentReceipt,
    issueId: parent.id,
    status: parent.status,
    updatedAt: parent.updatedAt.toISOString(),
    requiredIntegrations,
  });
  return [
    ...(parentHealthy ? [] : [{
      issueId: parent.id,
      identifier: parent.identifier,
      reason: "parent_integration_receipt_missing_or_stale" as const,
    }]),
    ...evaluateParentIntegrationReconciliationFailures(children, receiptBodies, requiredIntegrations),
  ];
}

export async function assertParentIntegrationReconciliationReady(
  dbOrTx: DbOrTx,
  parentIssueId: string,
  options: { lock?: boolean } = {},
): Promise<void> {
  const failures = await getParentIntegrationReconciliationFailures(dbOrTx, parentIssueId, options);
  if (failures.length === 0) return;
  throw conflict("Parent closure is waiting for terminal children and required integration reconciliation", {
    code: "parent_integration_reconciliation_pending",
    parentIssueId,
    failures,
  });
}
