import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginEvent,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";
import {
  isOutlineActiveConfig,
  parseModuleConfig,
  WorkflowRequestError,
  type AuditIdentity,
} from "./contracts.js";
import { ShadowReconciler } from "./reconciler.js";
import { PostgresWorkflowRepository } from "./repository.js";
import { assertOutlineModuleActivationUsable, parseOutlineModuleActivation } from "./modules/outline/activation.js";
import { PostgresOutlineAssessmentRepository } from "./modules/outline/assessment.js";
import { createOutlineRuntime } from "./modules/outline/runtime.js";
import {
  parseSentryPilotConfig,
  PluginSentryControlPlane,
  PostgresSentryWorkflowRepository,
  SentryApiClient,
  SentryWorkflow,
  SentryWorkflowConfigError,
  SlackApiClient,
  type SentryPilotConfig,
} from "./modules/sentry/index.js";

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx) {
    const repository = new PostgresWorkflowRepository(ctx.db);
    const outlineAssessments = new PostgresOutlineAssessmentRepository(ctx.db);
    // The host resolves the company connection and credentials from the
    // manifest-managed deny-by-default profile and returns sanitized receipts.
    const outlineRuntime = createOutlineRuntime({
      assessments: outlineAssessments,
      managedToolProfiles: ctx.managedToolProfiles,
    });
    const reconciler = new ShadowReconciler(repository, undefined, outlineRuntime);
    const sentryRepository = new PostgresSentryWorkflowRepository(ctx.db);
    const sentryControlPlane = new PluginSentryControlPlane(ctx);
    const sentryWorkflow = new SentryWorkflow(
      sentryRepository,
      sentryControlPlane,
      new SentryApiClient(ctx.http),
      new SlackApiClient(ctx.http),
      async (config, provider) => {
        const secretRef = provider === "sentry" ? config.sentry.tokenRef : config.slack.tokenRef;
        if (!secretRef) throw new SentryWorkflowConfigError(`${provider}_secret_missing`, `${provider} secret reference is missing`);
        return ctx.secrets.resolve(secretRef, { companyId: config.companyId, configPath: `sentry.${provider}.tokenRef` });
      },
    );

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

    const pollSentryForAllCompanies = async (job: PluginJobContext): Promise<void> => {
      let offset = 0;
      const limit = 100;
      while (true) {
        const companies = await ctx.companies.list({ limit, offset });
        for (const company of companies) {
          try {
            const result = await sentryWorkflow.reconcileCompany({
              companyId: company.id,
              audit: systemAudit(job.runId),
            });
            await ctx.metrics.write("sentry_issues_observed", result.observed, { companyId: company.id });
            await ctx.metrics.write("sentry_triage_created", result.triageCreated, { companyId: company.id });
            await ctx.metrics.write("sentry_notifications_sent", result.notificationsSent, { companyId: company.id });
            await ctx.metrics.write("sentry_workflow_exceptions", result.exceptions, { companyId: company.id });
          } catch {
            ctx.logger.error("Company Sentry reconciliation failed closed", {
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
    ctx.jobs.register("sentry-poll", pollSentryForAllCompanies);

    ctx.events.on("issue.created", async (event) => {
      await reconcileEventHint(reconciler, event);
    });

    ctx.events.on("issue.updated", async (event) => {
      await reconcileEventHint(reconciler, event);
    });

    const reconcileSentryDocument = async (event: PluginEvent): Promise<void> => {
      if (!event.entityId) return;
      const payload = objectBody(event.payload);
      const key = typeof payload.key === "string" ? payload.key : payload.documentKey;
      if (key !== "remediation-proposal") return;
      await sentryWorkflow.reconcileTriageIssue(event.companyId, event.entityId, {
        actorType: event.actorType ?? "system",
        actorId: event.actorId ?? null,
        runId: null,
      });
    };
    ctx.events.on("issue.document.created", reconcileSentryDocument);
    ctx.events.on("issue.document.updated", reconcileSentryDocument);

    apiHandler = async (input) => {
      if (input.routeKey === "report") {
        return { body: await reconciler.getReport(input.companyId) };
      }
      if (input.routeKey === "sentry.report") {
        return { body: await sentryWorkflow.getReport(input.companyId) };
      }

      const body = objectBody(input.body);
      const audit = auditFromApi(input);
      if (input.routeKey === "config.upsert") {
        const config = parseModuleConfig({ ...body, companyId: input.companyId });
        if (config.outlineActivation) {
          // Fail closed at the configuration boundary: exact destination/tool set,
          // switches, approval fingerprint, writer proofs, and expiry must all pass.
          config.outlineActivation = parseOutlineModuleActivation(config.outlineActivation);
          assertOutlineModuleActivationUsable(config.outlineActivation);
        }
        const project = await ctx.projects.get(config.projectId, input.companyId);
        if (!project) {
          throw new WorkflowRequestError(
            404,
            "project_not_found",
            "Project not found in the authorized company",
            "Project not found",
          );
        }
        await repository.upsertConfig(config, audit);
        const active = isOutlineActiveConfig(config);
        await ctx.activity.log({
          companyId: input.companyId,
          entityType: "project",
          entityId: config.projectId,
          message: `Stay Operational Workflows updated ${config.module} ${active ? "approved activation" : "shadow"} configuration`,
          metadata: {
            module: config.module,
            enabled: config.enabled,
            readOnly: config.readOnly,
            destinationEnabled: config.destinationEnabled,
            policyVersion: config.policyVersion,
            sourceVersion: config.sourceVersion,
          },
        });
        return { body: { config, mode: active ? "active" : "shadow", externalWritesEnabled: active } };
      }
      if (input.routeKey === "sentry.config.upsert") {
        const config = parseSentryPilotConfig({ ...body, companyId: input.companyId });
        const project = await ctx.projects.get(config.projectId, input.companyId);
        if (!project) {
          throw new WorkflowRequestError(
            404,
            "project_not_found",
            "Project not found in the authorized company",
            "Project not found",
          );
        }
        await sentryControlPlane.verifyExactConfigurationApproval(config);
        await sentryRepository.upsertConfig(config, audit);
        await ctx.activity.log({
          companyId: input.companyId,
          entityType: "project",
          entityId: config.projectId,
          message: "Stay Operational Workflows updated the governed Sentry pilot configuration",
          metadata: {
            pollingEnabled: config.pollingEnabled,
            slackEnabled: config.slackEnabled,
            policyVersion: config.policyVersion,
            sentryOrganizationId: config.sentry.organizationId,
            sentryProjectId: config.sentry.projectId,
            sentryEnvironment: config.sentry.environment,
            slackTeamId: config.slack.teamId,
            slackChannelId: config.slack.channelId,
          },
        });
        return {
          body: {
            config: redactSentryConfig(config),
            mode: config.pollingEnabled ? "active-approved" : "disabled",
            slackNotificationOnly: true,
          },
        };
      }
      if (input.routeKey === "reconcile.manual") {
        const result = await reconciler.reconcileCompany({
          companyId: input.companyId,
          trigger: "manual",
          audit,
        });
        await ctx.activity.log({
          companyId: input.companyId,
          message: "Stay Operational Workflows completed a manual reconciliation",
          metadata: {
            runId: result.runId,
            mode: result.mode,
            scanned: result.scanned,
            shadowed: result.shadowed,
            published: result.published,
            duplicates: result.duplicates,
            exceptions: result.exceptions,
            externalWrites: result.externalWrites,
          },
        });
        return { body: result };
      }
      if (input.routeKey === "sentry.reconcile.manual") {
        const result = await sentryWorkflow.reconcileCompany({
          companyId: input.companyId,
          mode: "manual",
          audit,
        });
        await ctx.activity.log({
          companyId: input.companyId,
          message: "Stay Operational Workflows completed a manual Sentry reconciliation",
          metadata: {
            observed: result.observed,
            triageCreated: result.triageCreated,
            proposalsBound: result.proposalsBound,
            notificationsSent: result.notificationsSent,
            remediationCreated: result.remediationCreated,
            duplicates: result.duplicates,
            exceptions: result.exceptions,
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
    try {
      return await apiHandler(input);
    } catch (error) {
      if (error instanceof WorkflowRequestError) {
        return {
          status: error.status,
          body: {
            error: error.publicMessage,
            code: error.code,
          },
        };
      }
      if (error instanceof SentryWorkflowConfigError) {
        return {
          status: 422,
          body: {
            error: error.message,
            code: error.code,
          },
        };
      }
      throw error;
    }
  },

  async onValidateConfig() {
    return {
      ok: true,
      warnings: [
        "Outline publishing stays disabled unless an approved activation payload with an accepted exact configuration fingerprint, current writer proofs, and a bound MCP runtime all match; default configurations remain zero-write.",
        "ClickUp remains structurally locked to shadow mode.",
        "Sentry polling and Slack notification remain disabled unless exact scope, least-privilege identities, non-expired proofs, and an immutable board-approved configuration revision all match.",
      ],
    };
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Operational reconciliation worker is running",
      details: {
        outlineMode: "activation-gated",
        clickupMode: "shadow",
        sentryMode: "configuration-gated",
        slackApprovalCapability: false,
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

function redactSentryConfig(config: SentryPilotConfig): Record<string, unknown> {
  return {
    ...config,
    sentry: {
      ...config.sentry,
      tokenRef: config.sentry.tokenRef ? { type: "secret_ref", configured: true } : null,
    },
    slack: {
      ...config.slack,
      tokenRef: config.slack.tokenRef ? { type: "secret_ref", configured: true } : null,
    },
  };
}

export default plugin;
runWorker(plugin, import.meta.url);
