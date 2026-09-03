import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  registerReflectionProposalSchema,
  validateReflectionTargetSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { accessService, heartbeatService, issueService, logActivity } from "../services/index.js";
import { reflectionLedgerService } from "../services/reflection-ledger.js";
import { getAccessibleResource, getActorInfo } from "./authz.js";

export function reflectionEvidenceRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const heartbeat = heartbeatService(db);
  const issues = issueService(db);
  const ledger = reflectionLedgerService(db);

  async function getIssue(req: Request, res: Response) {
    const issue = await getAccessibleResource(
      req,
      res,
      issues.getById(req.params.id as string),
      "Issue not found",
    );
    return issue;
  }

  async function assertIssueAction(
    req: Request,
    res: Response,
    issue: NonNullable<Awaited<ReturnType<typeof getIssue>>>,
    action: "issue:read" | "issue:mutate",
  ) {
    const decision = await access.decide({
      actor: req.actor,
      action,
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        status: issue.status,
      },
      scope: {
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
      },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Issue is outside this actor's authorization boundary" });
    return false;
  }

  router.get("/issues/:id/reflection-evidence", async (req, res) => {
    const issue = await getIssue(req, res);
    if (!issue || !(await assertIssueAction(req, res, issue, "issue:read"))) return;
    res.json(await ledger.listForIssue(issue));
  });

  router.get("/issues/:id/reflection-receipts/:receiptId", async (req, res) => {
    const issue = await getIssue(req, res);
    if (!issue || !(await assertIssueAction(req, res, issue, "issue:read"))) return;
    res.json(await ledger.getReceiptForIssue(issue, req.params.receiptId as string));
  });

  router.post(
    "/issues/:id/reflection-proposals",
    validate(registerReflectionProposalSchema),
    async (req, res) => {
      const issue = await getIssue(req, res);
      if (!issue || !(await assertIssueAction(req, res, issue, "issue:mutate"))) return;
      if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.runId) {
        throw forbidden("A Reflection Coach agent run is required to register a reflection proposal");
      }
      const actor = getActorInfo(req);
      const targets = await ledger.registerProposal(issue, req.body, {
        agentId: req.actor.agentId,
        runId: req.actor.runId,
      });
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "reflection.proposal_registered",
        entityType: "issue",
        entityId: issue.id,
        details: {
          proposalKey: req.body.proposalKey,
          targetIds: targets.map((target) => target.id),
          targetCount: targets.length,
        },
      });
      res.status(200).json({ version: 1, targets });
    },
  );

  router.post(
    "/issues/:id/reflection-targets/:targetId/validate",
    validate(validateReflectionTargetSchema),
    async (req, res) => {
      const issue = await getIssue(req, res);
      if (!issue || !(await assertIssueAction(req, res, issue, "issue:mutate"))) return;
      const actor = getActorInfo(req);
      if (actor.actorType === "agent" && !actor.runId) {
        throw forbidden("An agent run is required to validate a reflection target");
      }
      const result = await ledger.validateTarget(
        issue,
        req.params.targetId as string,
        req.body.evidenceMarkdown,
        {
          agentId: actor.agentId,
          runId: actor.runId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );
      if (result.changed) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "reflection.target_independently_validated",
          entityType: "issue",
          entityId: issue.id,
          details: { targetId: result.target.id, targetKey: result.target.targetKey },
        });
        if (issue.assigneeAgentId && issue.assigneeAgentId !== actor.agentId) {
          void heartbeat.wakeup(issue.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: {
              issueId: issue.id,
              reflectionTargetId: result.target.id,
              mutation: "reflection_evidence",
            },
            idempotencyKey: `reflection-evidence:${result.target.id}:independently_validated`,
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: issue.id,
              taskId: issue.id,
              reflectionTargetId: result.target.id,
              wakeReason: "reflection_evidence",
              source: "reflection.target.validation",
            },
          }).catch((error) => logger.warn({
            error,
            issueId: issue.id,
            targetId: result.target.id,
            agentId: issue.assigneeAgentId,
          }, "failed to wake reflection issue owner after independent validation"));
        }
      }
      res.json({ ...result, replay: !result.changed });
    },
  );

  return router;
}
