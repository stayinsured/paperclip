import { describe, expect, it, vi } from "vitest";
import { heartbeatRuns, issues, pluginExecutionAttempts } from "@paperclipai/db";
import { resolveLedgerScopeForRun } from "../services/heartbeat.ts";

type IssueRow = { id: string; projectId: string | null; billingCode: string | null };
type PluginAttemptRow = { id: string; billingCode: string };

type LedgerDb = Parameters<typeof resolveLedgerScopeForRun>[0];

function makeDb(input: { issues?: IssueRow[]; pluginAttempts?: PluginAttemptRow[] }) {
  const select = vi.fn(() => ({
    from: (table: unknown) => ({
      where: () => Promise.resolve(
        table === pluginExecutionAttempts
          ? input.pluginAttempts ?? []
          : table === issues
            ? input.issues ?? []
            : [],
      ),
    }),
  }));
  return { db: { select } as unknown as LedgerDb, select };
}

function makeRun(contextSnapshot: Record<string, unknown>) {
  return { id: "run-1", contextSnapshot } as unknown as typeof heartbeatRuns.$inferSelect;
}

describe("resolveLedgerScopeForRun billing code propagation", () => {
  it("carries the issue billing code onto the ledger scope", async () => {
    const { db } = makeDb({
      issues: [{ id: "issue-1", projectId: "project-1", billingCode: "ACME-42" }],
    });

    const scope = await resolveLedgerScopeForRun(db, "company-1", makeRun({
      issueId: "issue-1",
      projectId: "context-project",
    }));

    expect(scope).toEqual({
      issueId: "issue-1",
      projectId: "project-1",
      billingCode: "ACME-42",
    });
  });

  it("resolves a null billing code when the issue has none set", async () => {
    const { db } = makeDb({
      issues: [{ id: "issue-1", projectId: "project-1", billingCode: null }],
    });

    const scope = await resolveLedgerScopeForRun(db, "company-1", makeRun({
      issueId: "issue-1",
      projectId: "context-project",
    }));

    expect(scope.billingCode).toBeNull();
    expect(scope.issueId).toBe("issue-1");
  });

  it("resolves a null billing code when the run has no issue in context", async () => {
    const { db, select } = makeDb({});

    const scope = await resolveLedgerScopeForRun(db, "company-1", makeRun({
      projectId: "context-project",
    }));

    expect(scope).toEqual({
      issueId: null,
      projectId: "context-project",
      billingCode: null,
    });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("resolves a null billing code when the issue is not visible to the company", async () => {
    const { db } = makeDb({});

    const scope = await resolveLedgerScopeForRun(db, "other-company", makeRun({
      issueId: "issue-1",
      projectId: "context-project",
    }));

    expect(scope).toEqual({
      issueId: null,
      projectId: "context-project",
      billingCode: null,
    });
  });

  it("prefers the durable plugin attempt by heartbeat run id without a context hint", async () => {
    const { db } = makeDb({
      pluginAttempts: [{ id: "attempt-1", billingCode: "STA-1832/outline-materiality" }],
      issues: [{ id: "issue-1", projectId: "project-1", billingCode: "spoofed-context" }],
    });

    const scope = await resolveLedgerScopeForRun(db, "company-1", makeRun({
      issueId: "issue-1",
    }));

    expect(scope).toEqual({
      issueId: null,
      projectId: null,
      billingCode: "STA-1832/outline-materiality",
      pluginExecutionAttemptId: "attempt-1",
    });
  });
});
