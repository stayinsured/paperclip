import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instructionMutationReceipts,
  instanceSettings,
  issueCreateIdempotencyKeys,
  issueThreadInteractions,
  issues,
  reflectionLedgerTargets,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  buildInstructionContentDiff,
  reflectionLedgerService,
} from "../services/reflection-ledger.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reflectionLedgerService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reflection-ledger-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(instructionMutationReceipts);
    await db.delete(reflectionLedgerTargets);
    await db.delete(issueThreadInteractions);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("preserves three targets through serialized decisions, separate applies, validation, and replays", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const unrelatedIssueId = randomUUID();
    const coachId = randomUUID();
    const qaId = randomUUID();
    const targetAgentId = randomUUID();
    const sourceRunId = randomUUID();
    const beforeOne = "# Agent\n";
    const afterOne = "# Agent\n\nRule one.\n";
    const beforeTwo = "# Agent\n\nRule one.\n";
    const afterTwo = "# Agent\n\nRule one.\nRule two.\n";
    const diffs = [
      buildInstructionContentDiff("AGENTS.md", beforeOne, afterOne),
      buildInstructionContentDiff("AGENTS.md", beforeTwo, afterTwo),
      buildInstructionContentDiff("AGENTS.md", afterTwo, `${afterTwo}Rule three.\n`),
    ];

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "REF",
      defaultResponsibleUserId: "board-user",
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(agents).values([
      {
        id: coachId,
        companyId,
        name: "Reflection Coach",
        role: "general",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: { canCreateSkills: true },
        metadata: {
          paperclipBuiltInAgent: {
            key: "reflection-coach",
            featureKeys: ["reflection-coach"],
          },
        },
      },
      {
        id: qaId,
        companyId,
        name: "QA",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: targetAgentId,
        companyId,
        name: "Target",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: coachId,
      status: "succeeded",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Review multi-target reflection",
        status: "in_review",
        priority: "medium",
        identifier: "REF-1",
        issueNumber: 1,
        assigneeAgentId: qaId,
        createdByAgentId: coachId,
      },
      {
        id: unrelatedIssueId,
        companyId,
        title: "Unrelated",
        status: "todo",
        priority: "medium",
        identifier: "REF-2",
        issueNumber: 2,
      },
    ]);

    const ledger = reflectionLedgerService(db);
    const interactions = issueThreadInteractionService(db);
    const issue = { id: issueId, companyId, projectId: null, goalId: null };
    const proposal = {
      version: 1 as const,
      proposalKey: "weekly:target:2026-08-31",
      targets: diffs.map((proposedDiff, index) => ({
        targetKey: `agent:${targetAgentId}:instructions:${index + 1}`,
        targetType: "agent_instructions" as const,
        targetLabel: `Instruction target ${index + 1}`,
        proposalRevision: `v${index + 1}`,
        proposedDiff,
        state: "proposed" as const,
      })),
    };

    const registered = await ledger.registerProposal(issue, proposal, {
      agentId: coachId,
      runId: sourceRunId,
    });
    const replayedRegistration = await ledger.registerProposal(issue, proposal, {
      agentId: coachId,
      runId: sourceRunId,
    });
    expect(replayedRegistration.map((target) => target.id)).toEqual(registered.map((target) => target.id));
    await expect(ledger.registerProposal(issue, {
      ...proposal,
      targets: proposal.targets.slice(0, 2),
    }, {
      agentId: coachId,
      runId: sourceRunId,
    })).rejects.toMatchObject({ status: 409 });

    const confirmations = [];
    for (const [index, target] of registered.entries()) {
      confirmations.push(await interactions.create(issue, {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee_on_accept",
        idempotencyKey: `reflection:${target.id}`,
        sourceRunId,
        payload: {
          version: 1,
          prompt: `Apply ${target.targetLabel}?`,
          detailsMarkdown: diffs[index],
          target: {
            type: "custom",
            key: target.targetKey,
            revisionId: target.proposalRevision,
          },
        },
      }, {
        agentId: coachId,
        runId: sourceRunId,
      }));
    }

    expect((await interactions.listForIssue(issueId)).map((row) => row.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);

    const firstAccepted = await interactions.acceptInteraction(issue, confirmations[0]!.id, {}, {
      userId: "board-user",
    });
    const firstAcceptReplay = await interactions.acceptInteraction(issue, confirmations[0]!.id, {}, {
      userId: "board-user",
    });
    expect(firstAcceptReplay.continuationIssue?.id).toBe(firstAccepted.continuationIssue?.id);
    expect(firstAccepted.continuationIssue).toMatchObject({
      assigneeAgentId: coachId,
      status: "todo",
    });

    const secondAccepted = await interactions.acceptInteraction(issue, confirmations[1]!.id, {}, {
      userId: "board-user",
    });
    await interactions.rejectInteraction(issue, confirmations[2]!.id, { reason: "Evidence did not justify this target." }, {
      userId: "board-user",
    });

    const applicationIssues = await db.select().from(issues).where(and(
      eq(issues.companyId, companyId),
      eq(issues.parentId, issueId),
      eq(issues.originKind, "reflection_application"),
    ));
    expect(applicationIssues).toHaveLength(2);
    expect(new Set(applicationIssues.map((row) => row.id))).toEqual(new Set([
      firstAccepted.continuationIssue!.id,
      secondAccepted.continuationIssue!.id,
    ]));
    expect(applicationIssues.every((row) => row.assigneeAgentId === coachId)).toBe(true);

    const applyRuns = [randomUUID(), randomUUID()];
    await db.insert(heartbeatRuns).values([
      {
        id: applyRuns[0],
        companyId,
        agentId: coachId,
        status: "running",
        contextSnapshot: { issueId: firstAccepted.continuationIssue!.id },
      },
      {
        id: applyRuns[1],
        companyId,
        agentId: coachId,
        status: "running",
        contextSnapshot: { issueId: secondAccepted.continuationIssue!.id },
      },
    ]);

    const firstGrant = await ledger.findInstructionConsent({
      companyId,
      actorAgentId: coachId,
      actorRunId: applyRuns[0]!,
      targetKey: registered[0]!.targetKey,
    });
    expect(firstGrant).not.toBeNull();
    await expect(ledger.consumeInstructionConsent({
      grant: firstGrant!,
      targetAgentId,
      instructionPath: "AGENTS.md",
      beforeContent: beforeOne,
      postWriteContent: "# Unauthorized variation\n",
      actorAgentId: coachId,
      actorRunId: applyRuns[0]!,
    })).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(instructionMutationReceipts)).toHaveLength(0);

    const firstReceipt = await ledger.consumeInstructionConsent({
      grant: firstGrant!,
      targetAgentId,
      instructionPath: "AGENTS.md",
      beforeContent: beforeOne,
      postWriteContent: afterOne,
      actorAgentId: coachId,
      actorRunId: applyRuns[0]!,
    });
    expect(firstReceipt).toMatchObject({
      replay: false,
      receipt: {
        beforeContent: beforeOne,
        appliedDiff: diffs[0],
        postWriteContent: afterOne,
        actorRunId: applyRuns[0],
        acceptedInteractionId: confirmations[0]!.id,
        applicationIssueId: firstAccepted.continuationIssue!.id,
      },
    });

    const firstReplayGrant = await ledger.findInstructionConsent({
      companyId,
      actorAgentId: coachId,
      actorRunId: applyRuns[0]!,
      targetKey: registered[0]!.targetKey,
    });
    expect(firstReplayGrant).toMatchObject({
      consumed: true,
      existingReceipt: { id: firstReceipt.receipt.id },
    });
    const receiptReplay = await ledger.consumeInstructionConsent({
      grant: firstReplayGrant!,
      targetAgentId,
      instructionPath: "AGENTS.md",
      beforeContent: afterOne,
      postWriteContent: afterOne,
      actorAgentId: coachId,
      actorRunId: applyRuns[0]!,
    });
    expect(receiptReplay).toMatchObject({ replay: true, receipt: { id: firstReceipt.receipt.id } });

    const secondGrant = await ledger.findInstructionConsent({
      companyId,
      actorAgentId: coachId,
      actorRunId: applyRuns[1]!,
      targetKey: registered[1]!.targetKey,
    });
    await ledger.consumeInstructionConsent({
      grant: secondGrant!,
      targetAgentId,
      instructionPath: "AGENTS.md",
      beforeContent: beforeTwo,
      postWriteContent: afterTwo,
      actorAgentId: coachId,
      actorRunId: applyRuns[1]!,
    });

    const qaRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: qaRunId,
      companyId,
      agentId: qaId,
      status: "running",
      contextSnapshot: { issueId },
    });
    const validated = await ledger.validateTarget(
      issue,
      registered[0]!.id,
      "QA verified the exact file path, unique rule, receipt diff, and authoritative readback.",
      { agentId: qaId, runId: qaRunId },
    );
    const validationReplay = await ledger.validateTarget(
      issue,
      registered[0]!.id,
      "QA verified the exact file path, unique rule, receipt diff, and authoritative readback.",
      { agentId: qaId, runId: qaRunId },
    );
    expect(validated.changed).toBe(true);
    expect(validationReplay.changed).toBe(false);

    const evidence = await ledger.listForIssue(issue);
    expect(Object.fromEntries(evidence.targets.map((target) => [target.targetKey, target.state]))).toEqual({
      [registered[0]!.targetKey]: "independently_validated",
      [registered[1]!.targetKey]: "applied",
      [registered[2]!.targetKey]: "rejected",
    });
    expect(evidence.receipts).toHaveLength(2);
    await expect(ledger.getReceiptForIssue(
      { id: unrelatedIssueId, companyId },
      firstReceipt.receipt.id,
    )).rejects.toMatchObject({ status: 404 });
    await expect(ledger.getReceiptForIssue(
      { id: issueId, companyId: randomUUID() },
      firstReceipt.receipt.id,
    )).rejects.toMatchObject({ status: 404 });
  });

  it("proves the exact three-target terminal ledger with every accepted target independently validated", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const coachId = randomUUID();
    const qaId = randomUUID();
    const targetAgentId = randomUUID();
    const sourceRunId = randomUUID();
    const applyRunId = randomUUID();
    const before = "# Agent\n";
    const after = "# Agent\n\nKeep terminal evidence explicit.\n";
    const proposedDiff = buildInstructionContentDiff("AGENTS.md", before, after);
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "TERM", defaultResponsibleUserId: "board-user", requireBoardApprovalForNewAgents: false });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(agents).values([
      { id: coachId, companyId, name: "Reflection Coach", role: "general", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: { canCreateSkills: true }, metadata: { paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: ["reflection-coach"] } } },
      { id: qaId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: targetAgentId, companyId, name: "Target", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Terminal reflection ledger", status: "in_review", priority: "medium", identifier: "TERM-1", issueNumber: 1, assigneeAgentId: qaId, createdByAgentId: coachId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: coachId, status: "succeeded", contextSnapshot: { issueId } });
    const ledger = reflectionLedgerService(db);
    const interactions = issueThreadInteractionService(db);
    const issue = { id: issueId, companyId, projectId: null, goalId: null };
    const registered = await ledger.registerProposal(issue, { version: 1, proposalKey: "terminal-trio", targets: [
      { targetKey: `agent:${targetAgentId}:instructions:accepted`, targetType: "agent_instructions", targetLabel: "Accepted", proposalRevision: "v1", proposedDiff, state: "proposed" },
      { targetKey: `agent:${targetAgentId}:instructions:rejected`, targetType: "agent_instructions", targetLabel: "Rejected", proposalRevision: "v1", proposedDiff, state: "proposed" },
      { targetKey: `agent:${targetAgentId}:instructions:no-change`, targetType: "agent_instructions", targetLabel: "No change", proposalRevision: "v1", evidenceMarkdown: "Authoritative readback already contains the rule exactly once.", state: "evidence_backed_no_change" },
    ] }, { agentId: coachId, runId: sourceRunId });
    const confirmations = [];
    for (const target of registered.slice(0, 2)) confirmations.push(await interactions.create(issue, { kind: "request_confirmation", continuationPolicy: "wake_assignee_on_accept", idempotencyKey: `reflection:${target.id}`, sourceRunId, payload: { version: 1, prompt: `Apply ${target.targetLabel}?`, detailsMarkdown: proposedDiff, target: { type: "custom", key: target.targetKey, revisionId: target.proposalRevision } } }, { agentId: coachId, runId: sourceRunId }));
    const accepted = await interactions.acceptInteraction(issue, confirmations[0].id, {}, { userId: "board-user" });
    await interactions.rejectInteraction(issue, confirmations[1].id, { reason: "Rejected with explicit evidence." }, { userId: "board-user" });
    await db.insert(heartbeatRuns).values({ id: applyRunId, companyId, agentId: coachId, status: "running", contextSnapshot: { issueId: accepted.continuationIssue.id } });
    const grant = await ledger.findInstructionConsent({ companyId, actorAgentId: coachId, actorRunId: applyRunId, targetKey: registered[0].targetKey });
    await ledger.consumeInstructionConsent({ grant: grant!, targetAgentId, instructionPath: "AGENTS.md", beforeContent: before, postWriteContent: after, actorAgentId: coachId, actorRunId: applyRunId });
    const qaRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: qaRunId, companyId, agentId: qaId, status: "running", contextSnapshot: { issueId } });
    await ledger.validateTarget(issue, registered[0].id, "QA verified receipt and authoritative readback.", { agentId: qaId, runId: qaRunId });
    const evidence = await ledger.listForIssue(issue);
    expect(evidence.targets).toHaveLength(3);
    expect(evidence.targets.map((target) => target.state).sort()).toEqual(["evidence_backed_no_change", "independently_validated", "rejected"]);
    const acceptedTargets = evidence.targets.filter((target) => target.acceptedAt !== null);
    expect(acceptedTargets).toHaveLength(1);
    expect(acceptedTargets.every((target) => target.state === "independently_validated")).toBe(true);
  });
});
