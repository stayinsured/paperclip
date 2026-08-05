import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues, projectWorkspaces, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { evaluateExecutionAdmission } from "./execution-admission.js";
import { issueService } from "./issues.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("execution admission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-admission-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("fails capabilities before activation and admits a fresh secret-free profile", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-08-05T09:00:00.000Z");
    const admissionPolicy = {
      requiredCapabilities: ["repository_write", "github_workflow_dispatch", "observability_read"],
      allowedAdapterTypes: ["process"],
      allowedModels: ["gpt-5"],
      requireGatewayReachable: true,
      requireWorkspaceAvailable: true,
      productionProviderMutation: false,
      maxProfileAgeSeconds: 900,
    };
    await db.insert(companies).values({
      id: companyId,
      name: "Admission test",
      issuePrefix: "ADM",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Control plane" });
    await db.insert(projectWorkspaces).values({
      companyId,
      projectId,
      name: "Local checkout",
      cwd: process.cwd(),
      sourceType: "local_path",
      isPrimary: true,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "DevOps",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { model: "gpt-5" },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Synthetic release",
      status: "todo",
      priority: "high",
      executionPolicy: {
        admission: admissionPolicy,
      },
    });

    const denied = await evaluateExecutionAdmission(db, { companyId, issueId, agentId, now });
    expect(denied.admitted).toBe(false);
    expect(denied.checks.filter((check) => !check.passed).map((check) => check.code)).toEqual([
      "capability:repository_write",
      "capability:github_workflow_dispatch",
      "capability:observability_read",
      "profile_fresh",
    ]);
    expect(denied.productionMutationAuthorized).toBe(false);
    await expect(issueService(db).update(issueId, {
      status: "in_progress",
      assigneeAgentId: agentId,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "execution_admission_failed" },
    });
    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)))
      .resolves.toEqual([{ status: "todo" }]);

    await db.update(agents).set({
      runtimeConfig: {
        admissionProfile: {
          gatewayReachable: true,
          workspaceAvailable: true,
          capabilities: {
            repository_write: true,
            github_workflow_dispatch: true,
            observability_read: true,
          },
          productionProviderMutationAuthorized: false,
          verifiedAt: now.toISOString(),
        },
      },
    }).where(eq(agents.id, agentId));
    const admitted = await evaluateExecutionAdmission(db, { companyId, issueId, agentId, now });
    expect(admitted.admitted).toBe(true);
    expect(admitted.productionMutationAuthorized).toBe(false);
    expect(admitted.checks.every((check) => check.passed)).toBe(true);
    const productionDenied = await evaluateExecutionAdmission(db, {
      companyId,
      issueId,
      agentId,
      now,
      executionPolicy: {
        admission: {
          ...admissionPolicy,
          productionProviderMutation: true,
        },
      },
    });
    expect(productionDenied.admitted).toBe(false);
    expect(productionDenied.checks.find((check) => check.code === "production_authorized")?.passed).toBe(false);
    await expect(issueService(db).update(issueId, {
      status: "in_progress",
      assigneeAgentId: agentId,
    })).resolves.toMatchObject({ status: "in_progress", assigneeAgentId: agentId });
  });
});
