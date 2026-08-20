import { describe, expect, it } from "vitest";
import { PLUGIN_CAPABILITIES } from "../constants.js";
import { pluginManagedRoutineDeclarationSchema, pluginManifestV1Schema, pluginUiSlotDeclarationSchema } from "./plugin.js";

describe("plugin capability constants", () => {
  it("exposes each capability once", () => {
    expect(new Set(PLUGIN_CAPABILITIES).size).toBe(PLUGIN_CAPABILITIES.length);
  });
});

describe("plugin manifest validators", () => {
  it("accepts existing-style plugins that do not request access or authorization capabilities", () => {
    const parsed = pluginManifestV1Schema.parse({
      id: "paperclip.compat-dashboard",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Compat Dashboard",
      description: "Dashboard-only plugin without access or authorization host APIs.",
      author: "Paperclip",
      categories: ["ui"],
      capabilities: ["ui.dashboardWidget.register"],
      entrypoints: {
        worker: "./dist/worker.js",
        ui: "./dist/ui.js",
      },
      ui: {
        slots: [
          {
            type: "dashboardWidget",
            id: "compat-dashboard",
            displayName: "Compat Dashboard",
            exportName: "CompatDashboard",
          },
        ],
      },
    });

    expect(parsed.capabilities).toEqual(["ui.dashboardWidget.register"]);
  });

  it("accepts sandbox provider template config bindings", () => {
    const parsed = pluginManifestV1Schema.parse({
      id: "paperclip.template-provider",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Template Provider",
      description: "Sandbox provider with captured template config binding.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["environment.drivers.register"],
      entrypoints: { worker: "./dist/worker.js" },
      environmentDrivers: [
        {
          driverKey: "template-provider",
          kind: "sandbox_provider",
          displayName: "Template Provider",
          supportsTemplateCapture: true,
          templateRefKind: "provider_template",
          templateConfigBinding: {
            field: "templateId",
            unsetFields: ["image"],
          },
          configSchema: { type: "object" },
        },
      ],
    });

    expect(parsed.environmentDrivers?.[0]?.templateConfigBinding).toEqual({
      field: "templateId",
      unsetFields: ["image"],
    });
  });

  it("rejects template config bindings that replace provider identity", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      id: "paperclip.bad-template-provider",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Bad Template Provider",
      categories: ["automation"],
      capabilities: ["environment.drivers.register"],
      entrypoints: { worker: "./dist/worker.js" },
      environmentDrivers: [
        {
          driverKey: "bad-template-provider",
          kind: "sandbox_provider",
          displayName: "Bad Template Provider",
          templateConfigBinding: {
            field: "provider",
          },
          configSchema: { type: "object" },
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("provider key"))).toBe(true);
  });
});

describe("plugin managed routine validators", () => {
  it("accepts core issue surface visibility values in routine templates", () => {
    const parsed = pluginManagedRoutineDeclarationSchema.parse({
      routineKey: "wiki.refresh",
      title: "Refresh Wiki",
      activityGatePolicy: "require_external_activity",
      activityGateScope: "project",
      issueTemplate: { surfaceVisibility: "default" },
    });

    expect(parsed.issueTemplate?.surfaceVisibility).toBe("default");
    expect(parsed.activityGatePolicy).toBe("require_external_activity");
    expect(parsed.activityGateScope).toBe("project");
  });

  it("rejects non-core issue surface visibility values in routine templates", () => {
    const parsed = pluginManagedRoutineDeclarationSchema.safeParse({
      routineKey: "wiki.refresh",
      title: "Refresh Wiki",
      issueTemplate: { surfaceVisibility: "normal" },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("plugin managed skill validators", () => {
  const baseManifest = {
    id: "paperclip.test-managed-skills",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed Skills",
    description: "Managed skills test plugin.",
    author: "Paperclip",
    categories: ["automation"],
    entrypoints: { worker: "./dist/worker.js" },
  } as const;

  it("requires skills.managed when managed skills are declared", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      ...baseManifest,
      capabilities: [],
      skills: [{ skillKey: "wiki-maintainer", displayName: "Wiki Maintainer" }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("skills.managed"))).toBe(true);
  });

  it("accepts managed skills with the skills.managed capability", () => {
    const parsed = pluginManifestV1Schema.parse({
      ...baseManifest,
      capabilities: ["skills.managed"],
      skills: [{ skillKey: "wiki-maintainer", displayName: "Wiki Maintainer" }],
    });

    expect(parsed.skills?.[0]?.skillKey).toBe("wiki-maintainer");
  });
});

describe("plugin managed tool profile validators", () => {
  const base = {
    id: "paperclip.outline-sync",
    apiVersion: 1,
    version: "0.3.0",
    displayName: "Outline Sync",
    description: "Brokered Outline reconciliation.",
    author: "Paperclip",
    categories: ["automation"],
    entrypoints: { worker: "./dist/worker.js" },
    agents: [{ agentKey: "outline-runtime", displayName: "Outline Runtime", identityOnly: "tool_profile" }],
    managedToolProfiles: [{
      profileKey: "outline",
      displayName: "Outline documents",
      principalAgentKey: "outline-runtime",
      connectionConfigPath: "outline.connectionId",
      tools: ["list_documents", "create_document", "update_document"],
    }],
  } as const;

  it("accepts an exact identity-only profile with its dedicated capability", () => {
    const parsed = pluginManifestV1Schema.parse({ ...base, capabilities: ["tools.profile.invoke"] });
    expect(parsed.managedToolProfiles?.[0]?.tools).toEqual(["list_documents", "create_document", "update_document"]);
  });

  it("rejects profiles without capability or an identity-only principal", () => {
    expect(pluginManifestV1Schema.safeParse({ ...base, capabilities: [] }).success).toBe(false);
    expect(pluginManifestV1Schema.safeParse({
      ...base,
      capabilities: ["tools.profile.invoke"],
      agents: [{ agentKey: "outline-runtime", displayName: "Outline Runtime" }],
    }).success).toBe(false);
  });

  it("rejects duplicate principals and orphan identity-only agents", () => {
    const duplicate = pluginManifestV1Schema.safeParse({
      ...base,
      capabilities: ["tools.profile.invoke"],
      managedToolProfiles: [
        base.managedToolProfiles[0],
        { ...base.managedToolProfiles[0], profileKey: "outline-second" },
      ],
    });
    expect(duplicate.success).toBe(false);
    const orphan = pluginManifestV1Schema.safeParse({
      ...base,
      capabilities: ["tools.profile.invoke"],
      agents: [...base.agents, { agentKey: "orphan", displayName: "Orphan", identityOnly: "tool_profile" }],
    });
    expect(orphan.success).toBe(false);
  });

  it("rejects duplicate tool entries", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      ...base,
      capabilities: ["tools.profile.invoke"],
      managedToolProfiles: [{ ...base.managedToolProfiles[0], tools: ["list_documents", "list_documents"] }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("plugin UI slot validators", () => {
  it("accepts route-scoped sidebar slots with a routePath", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "routeSidebar",
      id: "wiki-route-sidebar",
      displayName: "Wiki Sidebar",
      exportName: "WikiSidebar",
      routePath: "wiki",
    });

    expect(parsed.routePath).toBe("wiki");
  });

  it("requires route-scoped sidebar slots to declare a routePath", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "routeSidebar",
      id: "wiki-route-sidebar",
      displayName: "Wiki Sidebar",
      exportName: "WikiSidebar",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toBe("routeSidebar slots require routePath");
  });

  it("keeps reserved company route protection for route-scoped sidebars", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "routeSidebar",
      id: "settings-route-sidebar",
      displayName: "Settings Sidebar",
      exportName: "SettingsSidebar",
      routePath: "settings",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("reserved by the host"))).toBe(true);
  });

  it("accepts workspace entity types as detailTab targets", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "detailTab",
      id: "workspace-diff-viewer",
      displayName: "Diff",
      exportName: "WorkspaceDiffViewer",
      entityTypes: ["execution_workspace", "project_workspace"],
    });

    expect(parsed.entityTypes).toEqual(["execution_workspace", "project_workspace"]);
  });

  it("accepts execution_workspace as a toolbarButton entityType", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "toolbarButton",
      id: "workspace-open-diff",
      displayName: "Open diff",
      exportName: "OpenWorkspaceDiffButton",
      entityTypes: ["execution_workspace"],
    });

    expect(parsed.entityTypes).toEqual(["execution_workspace"]);
  });

  it("accepts company settings page slots with a non-core settings route", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "companySettingsPage",
      id: "permissions-settings",
      displayName: "Permissions",
      exportName: "PermissionsSettingsPage",
      routePath: "permissions",
    });

    expect(parsed.routePath).toBe("permissions");
  });

  it("prevents company settings page slots from shadowing core settings routes", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "companySettingsPage",
      id: "instance-settings",
      displayName: "Instance",
      exportName: "InstanceSettingsPage",
      routePath: "instance",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("reserved by the host"))).toBe(true);
  });
});
