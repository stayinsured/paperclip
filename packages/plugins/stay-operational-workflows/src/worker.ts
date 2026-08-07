import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginEvent,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";
import { parseModuleConfig, type AuditIdentity } from "./contracts.js";
import { ShadowReconciler } from "./reconciler.js";
import { PostgresWorkflowRepository } from "./repository.js";

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx) {
    const repository = new PostgresWorkflowRepository(ctx.db);
    const reconciler = new ShadowReconciler(repository);

    const systemAudit = (runId: string | null): AuditIdentity => ({
      actorType: "system",
      actorId: null,
      runId,
    });

    const reconcileAllCompanies = async (job: PluginJobContext): Promise<void> => {
      let offset = 0;
      const limit = 100;
      while (true) {
        const companies = await ctx.companies.list({ limit, offset });
        for (const company of companies) {
          try {
            const result = await reconciler.reconcileCompany({
              companyId: company.id,
              trigger: job.trigger === "retry" ? "retry" : "schedule",
              audit: systemAudit(job.runId),
            });
            await ctx.metrics.write("reconciliation_scanned", result.scanned, { mode: result.mode });
            await ctx.metrics.write("external_writes", result.externalWrites, { mode: result.mode });
          } catch {
            ctx.logger.error("Company shadow reconciliation failed", {
              companyId: company.id,
              runId: job.runId,
            });
          }
        }
        if (companies.length < limit) break;
        offset += limit;
      }
    };

    ctx.jobs.register("reconcile", reconcileAllCompanies);

    ctx.events.on("issue.created", async (event) => {
      await reconcileEventHint(reconciler, event);
    });

    ctx.events.on("issue.updated", async (event) => {
      await reconcileEventHint(reconciler, event);
    });


    apiHandler = async (input) => {
      if (input.routeKey === "report") {
        return { body: await reconciler.getReport(input.companyId) };
      }

      const body = objectBody(input.body);
      const audit = auditFromApi(input);
      if (input.routeKey === "config.upsert") {
        const config = parseModuleConfig({ ...body, companyId: input.companyId });
        const project = await ctx.projects.get(config.projectId, input.companyId);
        if (!project) throw new Error("Project not found in the authorized company");
        await repository.upsertConfig(config, audit);
        await ctx.activity.log({
          companyId: input.companyId,
          entityType: "project",
          entityId: config.projectId,
          message: `Stay Operational Workflows updated ${config.module} shadow configuration`,
          metadata: {
            module: config.module,
            enabled: config.enabled,
            readOnly: config.readOnly,
            destinationEnabled: config.destinationEnabled,
            policyVersion: config.policyVersion,
            sourceVersion: config.sourceVersion,
          },
        });
        return { body: { config, mode: "shadow", externalWritesEnabled: false } };
      }
      if (input.routeKey === "reconcile.manual") {
        const result = await reconciler.reconcileCompany({
          companyId: input.companyId,
          trigger: "manual",
          audit,
        });
        await ctx.activity.log({
          companyId: input.companyId,
          message: "Stay Operational Workflows completed a manual shadow reconciliation",
          metadata: {
            runId: result.runId,
            scanned: result.scanned,
            shadowed: result.shadowed,
            duplicates: result.duplicates,
            exceptions: result.exceptions,
            externalWrites: 0,
          },
        });
        return { body: result };
      }
      if (input.routeKey === "operation.replay") {
        const result = await reconciler.replay({
          companyId: input.companyId,
          operationId: requiredString(input.params.operationId, "operationId"),
          audit,
        });
        await ctx.activity.log({
          companyId: input.companyId,
          entityType: "plugin_operation",
          entityId: input.params.operationId,
          message: "Stay Operational Workflows manually replayed a shadow operation",
          metadata: {
            runId: result.runId,
            duplicates: result.duplicates,
            exceptions: result.exceptions,
            externalWrites: 0,
          },
        });
        return { body: result };
      }
      return { status: 404, body: { error: `Unknown route: ${input.routeKey}` } };
    };
  },

  async onApiRequest(input) {
    if (!apiHandler) throw new Error("Plugin API handler is not ready");
    return apiHandler(input);
  },

  async onValidateConfig() {
    return {
      ok: true,
      warnings: [
        "This release is structurally locked to shadow mode; external writes and provider credentials are unsupported.",
      ],
    };
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Shadow reconciliation worker is running",
      details: {
        mode: "shadow",
        externalWritesEnabled: false,
        authoritativeSource: "scheduled-reconciliation",
        eventRole: "latency-hint",
      },
    };
  }
});

let apiHandler:
  | ((input: PluginApiRequestInput) => Promise<{ status?: number; body?: unknown }>)
  | null = null;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function auditFromApi(input: PluginApiRequestInput): AuditIdentity {
  return {
    actorType: input.actor.actorType,
    actorId: input.actor.userId ?? input.actor.agentId ?? input.actor.actorId,
    runId: input.actor.runId ?? null,
  };
}

async function reconcileEventHint(reconciler: ShadowReconciler, event: PluginEvent): Promise<void> {
  if (!event.entityId) return;
  await reconciler.reconcileCompany({
    companyId: event.companyId,
    trigger: "event",
    sourceId: event.entityId,
    audit: {
      actorType: event.actorType ?? "system",
      actorId: event.actorId ?? null,
      runId: null,
    },
  });
}

export default plugin;
runWorker(plugin, import.meta.url);
