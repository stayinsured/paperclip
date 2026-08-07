import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "staydigital.stay-operational-workflows",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Stay Operational Workflows",
  description: "Company-scoped shadow foundation for governed Outline, ClickUp, and Sentry/Slack workflows.",
  author: "Stay Digital Products",
  categories: ["automation"],
  capabilities: [
    "activity.log.write",
    "api.routes.register",
    "companies.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "events.subscribe",
    "jobs.schedule",
    "metrics.write"
  ],
  entrypoints: {
    worker: "./dist/worker.js"
  },
  database: {
    namespaceSlug: "stay_operational_workflows",
    migrationsDir: "migrations",
    coreReadTables: ["companies", "issues", "projects"]
  },
  jobs: [
    {
      jobKey: "reconcile",
      displayName: "Reconcile operational workflows",
      description: "Authoritative company-scoped shadow reconciliation. Paperclip events are latency hints only.",
      schedule: "*/5 * * * *"
    }
  ],
  apiRoutes: [
    {
      routeKey: "config.upsert",
      method: "POST",
      path: "/config",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" }
    },
    {
      routeKey: "report",
      method: "GET",
      path: "/report",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" }
    },
    {
      routeKey: "reconcile.manual",
      method: "POST",
      path: "/reconcile",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" }
    },
    {
      routeKey: "operation.replay",
      method: "POST",
      path: "/operations/:operationId/replay",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" }
    }
  ]
};

export default manifest;
