import type { RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { logActivity } from "../services/activity-log.js";

/** Global deny boundary: a plugin_execution JWT can reach only its own MCP callback URL. */
export function pluginExecutionIngressGuard(db: Db): RequestHandler {
  return (req, _res, next) => {
    const scope = req.actor.type === "agent" && req.actor.keyScope?.kind === "plugin_execution"
      ? req.actor.keyScope
      : null;
    if (!scope) {
      next();
      return;
    }
    const allowedPath = `/plugin-executions/${scope.attemptId}/mcp`;
    if (req.method === "POST" && req.path === allowedPath && req.actor.agentId === scope.principalAgentId && req.actor.companyId === scope.companyId && req.actor.runId === scope.heartbeatRunId) {
      next();
      return;
    }
    void logActivity(db, {
      companyId: scope.companyId,
      actorType: "agent",
      actorId: scope.principalAgentId,
      action: "plugin_execution.ingress_denied",
      entityType: "plugin_execution_attempt",
      entityId: scope.attemptId,
      agentId: scope.principalAgentId,
      runId: scope.heartbeatRunId,
      details: { method: req.method, path: req.path },
    })
      .catch(() => undefined)
      .then(() => next(forbidden("plugin_execution capabilities cannot access ordinary Paperclip APIs", { code: "plugin_execution_ingress_denied" })));
  };
}
