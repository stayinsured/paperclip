import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { pluginExecutionAttemptService } from "../services/plugin-execution-attempts.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";

export function pluginExecutionRoutes(db: Db, dispatcher: PluginToolDispatcher) {
  const router = Router();
  const attempts = pluginExecutionAttemptService(db);

  router.post("/plugin-executions/:attemptId/mcp", async (req, res, next) => {
    try {
      const scope = req.actor.type === "agent" && req.actor.keyScope?.kind === "plugin_execution" ? req.actor.keyScope : null;
      if (!scope || scope.attemptId !== req.params.attemptId) throw forbidden("Restricted execution capability required");
      const body = (req.body ?? {}) as { id?: unknown; method?: string; params?: Record<string, unknown> };
      const id = body.id ?? null;
      if (body.method === "initialize") {
        await attempts.validateScope(scope, "discovery");
        res.json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Paperclip Restricted Plugin Gateway", version: "1.0.0" } } });
        return;
      }
      if (body.method === "notifications/initialized") {
        await attempts.validateScope(scope, "discovery");
        res.status(202).end();
        return;
      }
      if (body.method === "tools/list") {
        await attempts.validateScope(scope, "discovery");
        const tool = dispatcher.getTool(scope.tool);
        if (!tool || tool.pluginDbId !== scope.pluginId || tool.pluginId !== scope.pluginKey) {
          await attempts.denyScopeCall(scope, "bound_tool_unavailable", { phase: "discovery" });
          throw forbidden("Bound plugin tool is unavailable or unowned");
        }
        res.json({ jsonrpc: "2.0", id, result: { tools: [{ name: tool.namespacedName, title: tool.displayName, description: tool.description, inputSchema: tool.parametersSchema }] } });
        return;
      }
      if (body.method === "tools/call") {
        const params = body.params ?? {};
        const name = typeof params.name === "string" ? params.name : "";
        const result = await attempts.callback(scope, name, params.arguments ?? {}, dispatcher);
        const record = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : null;
        const text = typeof record?.content === "string" ? record.content : JSON.stringify(record?.data ?? result ?? null);
        res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], structuredContent: record?.data ?? null, isError: Boolean(record?.error) } });
        return;
      }
      await attempts.denyScopeCall(scope, "malformed_or_unsupported_mcp_method", { method: body.method ?? null });
      res.status(404).json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
