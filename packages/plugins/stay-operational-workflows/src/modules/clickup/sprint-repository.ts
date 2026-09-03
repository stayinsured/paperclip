import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ClickUpSprintRepository, IssueSprintLink, WeeklySprint } from "./types.js";

export class PostgresClickUpSprintRepository implements ClickUpSprintRepository {
  private readonly namespace: string;
  constructor(private readonly db: PluginContext["db"]) {
    if (!db.namespace) throw new Error("Plugin database namespace is not available");
    this.namespace = db.namespace;
  }
  private table(name: string): string { return `${this.namespace}.${name}`; }
  async listWeeklySprints(companyId: string, projectId: string): Promise<WeeklySprint[]> {
    const rows = await this.db.query<{ id: string; company_id: string; project_id: string; name: string; start_date: string; end_date: string; timezone: string | null }>(
      `SELECT id, company_id, project_id, name, start_date::text, end_date::text, timezone FROM ${this.table("weekly_sprints")} WHERE company_id = $1 AND project_id = $2 ORDER BY start_date, id`, [companyId, projectId],
    );
    return rows.map((row) => ({ id: row.id, companyId: row.company_id, projectId: row.project_id, name: row.name, startDate: row.start_date, endDate: row.end_date, timezone: row.timezone }));
  }
  async linkIssueToSprints(input: { companyId: string; projectId: string; issueId: string; sprintIds: string[] }): Promise<IssueSprintLink[]> {
    const links: IssueSprintLink[] = [];
    for (const sprintId of new Set(input.sprintIds)) {
      const rows = await this.db.query<{ id: string; company_id: string; project_id: string; issue_id: string; sprint_id: string }>(
        `INSERT INTO ${this.table("clickup_issue_sprint_links")} (id, company_id, project_id, issue_id, sprint_id)
         SELECT $1, $2, $3, $4, id FROM ${this.table("weekly_sprints")} WHERE id = $5 AND company_id = $2 AND project_id = $3
         ON CONFLICT (company_id, issue_id, sprint_id) DO UPDATE SET updated_at = now()
         RETURNING id, company_id, project_id, issue_id, sprint_id`, [randomUUID(), input.companyId, input.projectId, input.issueId, sprintId],
      );
      const row = rows[0];
      if (!row) throw new Error("ClickUp sprint link scope mismatch");
      links.push({ id: row.id, companyId: row.company_id, projectId: row.project_id, issueId: row.issue_id, sprintId: row.sprint_id });
    }
    return links;
  }
}
