import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ClickUpConflict, ClickUpLinkRepository, ClickUpOwnedSnapshot, ClickUpTaskLink } from "./types.js";

type LinkRow = {
  id: string;
  company_id: string;
  project_id: string;
  issue_id: string;
  list_id: string;
  task_id: string;
  task_url: string | null;
  origin_side: ClickUpTaskLink["originSide"];
  correlation_value_hash: string;
  base_snapshot: ClickUpOwnedSnapshot;
  last_projection_version: string;
  last_external_revision: string | null;
  status: ClickUpTaskLink["status"];
  last_projected_at: string | null;
  last_reconciled_at: string | null;
};

function linkFromRow(row: LinkRow): ClickUpTaskLink {
  return {
    id: row.id,
    companyId: row.company_id,
    projectId: row.project_id,
    issueId: row.issue_id,
    listId: row.list_id,
    taskId: row.task_id,
    taskUrl: row.task_url,
    originSide: row.origin_side,
    correlationValueHash: row.correlation_value_hash,
    baseSnapshot: row.base_snapshot,
    lastProjectionVersion: row.last_projection_version,
    lastExternalRevision: row.last_external_revision,
    status: row.status,
    lastProjectedAt: row.last_projected_at,
    lastReconciledAt: row.last_reconciled_at,
  };
}

export class PostgresClickUpRepository implements ClickUpLinkRepository {
  private readonly namespace: string;

  constructor(private readonly db: PluginContext["db"]) {
    if (!db.namespace) throw new Error("Plugin database namespace is not available");
    this.namespace = db.namespace;
  }

  private table(name: string): string {
    return `${this.namespace}.${name}`;
  }

  private async queryOne(sql: string, params: unknown[]): Promise<ClickUpTaskLink | null> {
    const rows = await this.db.query<LinkRow>(sql, params);
    return rows[0] ? linkFromRow(rows[0]) : null;
  }

  async getByIssue(companyId: string, issueId: string): Promise<ClickUpTaskLink | null> {
    return this.queryOne(
      `SELECT id, company_id, project_id, issue_id, list_id, task_id, task_url, origin_side,
              correlation_value_hash, base_snapshot, last_projection_version, last_external_revision,
              status, last_projected_at::text AS last_projected_at,
              last_reconciled_at::text AS last_reconciled_at
       FROM ${this.table("clickup_task_links")}
       WHERE company_id = $1 AND issue_id = $2`,
      [companyId, issueId],
    );
  }

  async getByExternalTask(companyId: string, listId: string, taskId: string): Promise<ClickUpTaskLink | null> {
    return this.queryOne(
      `SELECT id, company_id, project_id, issue_id, list_id, task_id, task_url, origin_side,
              correlation_value_hash, base_snapshot, last_projection_version, last_external_revision,
              status, last_projected_at::text AS last_projected_at,
              last_reconciled_at::text AS last_reconciled_at
       FROM ${this.table("clickup_task_links")}
       WHERE company_id = $1 AND list_id = $2 AND task_id = $3`,
      [companyId, listId, taskId],
    );
  }

  async upsertLink(input: Omit<ClickUpTaskLink, "id">): Promise<ClickUpTaskLink> {
    await this.db.execute(
      `INSERT INTO ${this.table("clickup_task_links")}
       (id, company_id, project_id, issue_id, list_id, task_id, task_url, origin_side,
        correlation_value_hash, base_snapshot, last_projection_version, last_external_revision,
        status, last_projected_at, last_reconciled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14::timestamptz, $15::timestamptz)
       ON CONFLICT (company_id, issue_id) DO UPDATE SET
         project_id = EXCLUDED.project_id, list_id = EXCLUDED.list_id,
         task_id = EXCLUDED.task_id, task_url = EXCLUDED.task_url,
         origin_side = EXCLUDED.origin_side, correlation_value_hash = EXCLUDED.correlation_value_hash,
         base_snapshot = EXCLUDED.base_snapshot, last_projection_version = EXCLUDED.last_projection_version,
         last_external_revision = EXCLUDED.last_external_revision, status = EXCLUDED.status,
         last_projected_at = EXCLUDED.last_projected_at, last_reconciled_at = EXCLUDED.last_reconciled_at,
         updated_at = now()`,
      [
        randomUUID(), input.companyId, input.projectId, input.issueId, input.listId, input.taskId,
        input.taskUrl, input.originSide, input.correlationValueHash, JSON.stringify(input.baseSnapshot),
        input.lastProjectionVersion, input.lastExternalRevision, input.status,
        input.lastProjectedAt, input.lastReconciledAt,
      ],
    );
    const stored = await this.getByIssue(input.companyId, input.issueId);
    if (!stored || stored.listId !== input.listId || stored.taskId !== input.taskId) {
      throw new Error("ClickUp task link upsert could not be read back with the requested identity");
    }
    return stored;
  }

  async recordConflicts(conflicts: ClickUpConflict[]): Promise<void> {
    for (const conflict of conflicts) {
      await this.db.execute(
        `INSERT INTO ${this.table("clickup_conflicts")}
         (id, company_id, project_id, issue_id, link_id, conflict_key, field, base_value,
          external_value, paperclip_value, external_updated_at, paperclip_updated_at, detected_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb,
                 $11::timestamptz, $12::timestamptz, $13::timestamptz, 'open')
         ON CONFLICT (company_id, conflict_key) DO UPDATE SET
           status = 'open', external_updated_at = EXCLUDED.external_updated_at,
           paperclip_updated_at = EXCLUDED.paperclip_updated_at,
           detected_at = EXCLUDED.detected_at, updated_at = now()`,
        [
          randomUUID(), conflict.companyId, conflict.projectId, conflict.issueId, conflict.linkId,
          conflict.conflictKey, conflict.field, JSON.stringify(conflict.baseValue),
          JSON.stringify(conflict.externalValue), JSON.stringify(conflict.paperclipValue),
          conflict.externalUpdatedAt, conflict.paperclipUpdatedAt, conflict.detectedAt,
        ],
      );
    }
  }
}
