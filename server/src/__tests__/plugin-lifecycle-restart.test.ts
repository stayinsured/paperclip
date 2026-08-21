/**
 * Regression test for PAP-9585.
 *
 * `restartWorker` is called by the dev file-watcher whenever a local-path
 * plugin's source files change. Before PAP-9585 it only bounced the worker
 * subprocess, which left newly added `migrations/*.sql` files unapplied — the
 * plugin schema would silently drift out of sync with worker code.
 *
 * The fix is for `restartWorker` to do a full deactivate + reactivate cycle
 * via the plugin loader, which re-reads the manifest from disk and runs
 * `applyMigrations` (idempotently) before starting the new worker.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginRecord = {
  id: "plugin-1",
  pluginKey: "example.plugin",
  status: "ready",
  manifestJson: { id: "example.plugin", capabilities: [] },
  packageName: "@example/plugin",
  version: "1.0.0",
  packagePath: "/tmp/example-plugin",
};

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
  install: vi.fn(),
  upsertConfig: vi.fn(),
  getConfig: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginLoader } from "../services/plugin-loader.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

function makeWorkerManagerStub() {
  const handle = {
    restart: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return {
    handle,
    workerManager: {
      getWorker: vi.fn().mockReturnValue(handle),
      isRunning: vi.fn().mockReturnValue(true),
      startWorker: vi.fn().mockResolvedValue(undefined),
      stopWorker: vi.fn().mockResolvedValue(undefined),
      restartWorker: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginWorkerManager,
  };
}

describe("pluginLifecycleManager.restartWorker", () => {
  it("does a full deactivate+reactivate cycle when the loader has runtime services", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.updateStatus.mockResolvedValue(pluginRecord);

    const { handle, workerManager } = makeWorkerManagerStub();

    const loader: Partial<PluginLoader> = {
      hasRuntimeServices: vi.fn().mockReturnValue(true) as PluginLoader["hasRuntimeServices"],
      loadSingle: vi.fn().mockResolvedValue({
        success: true,
        plugin: pluginRecord,
        registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
      }) as PluginLoader["loadSingle"],
      unloadSingle: vi.fn().mockResolvedValue(undefined) as PluginLoader["unloadSingle"],
    };

    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: loader as PluginLoader, workerManager },
    );
    const stopped = vi.fn();
    const started = vi.fn();
    lifecycle.on("plugin.worker_stopped", stopped);
    lifecycle.on("plugin.worker_started", started);

    await lifecycle.restartWorker("plugin-1");

    expect(loader.unloadSingle).toHaveBeenCalledWith("plugin-1", "example.plugin");
    expect(loader.loadSingle).toHaveBeenCalledWith("plugin-1");
    // The bare worker handle should NOT be bounced — the loader handles
    // worker (re)start as part of activate.
    expect(handle.restart).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });

  it("falls back to bouncing the worker handle when the loader has no runtime services", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.updateStatus.mockResolvedValue(pluginRecord);

    const { handle, workerManager } = makeWorkerManagerStub();

    const loader: Partial<PluginLoader> = {
      hasRuntimeServices: vi.fn().mockReturnValue(false) as PluginLoader["hasRuntimeServices"],
      loadSingle: vi.fn() as PluginLoader["loadSingle"],
      unloadSingle: vi.fn() as PluginLoader["unloadSingle"],
    };

    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: loader as PluginLoader, workerManager },
    );
    const stopped = vi.fn();
    const started = vi.fn();
    lifecycle.on("plugin.worker_stopped", stopped);
    lifecycle.on("plugin.worker_started", started);

    await lifecycle.restartWorker("plugin-1");

    expect(loader.unloadSingle).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(handle.restart).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledWith({ pluginId: "plugin-1", pluginKey: "example.plugin" });
    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith({ pluginId: "plugin-1", pluginKey: "example.plugin" });
  });
});

describe("pluginLifecycleManager.upgrade", () => {
  const oldManifest = {
    id: "example.plugin",
    version: "1.0.0",
    apiVersion: 1,
    categories: [],
    capabilities: ["events.subscribe"],
  } as const;
  const newManifest = {
    ...oldManifest,
    version: "1.1.0",
  };
  const discovered = {
    packageName: "@example/plugin",
    packagePath: "/tmp/example-plugin",
    version: "1.1.0",
    manifest: newManifest,
    source: "local-filesystem",
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupUpgrade(options?: {
    addedCapabilities?: string[];
    failure?: Error;
    initialStatus?: "ready" | "upgrade_pending";
  }) {
    const initialStatus = options?.initialStatus ?? "ready";
    const targetManifest = {
      ...newManifest,
      capabilities: [...newManifest.capabilities, ...(options?.addedCapabilities ?? [])],
    };
    const initialRecord = { ...pluginRecord, status: initialStatus, manifestJson: oldManifest };
    const pendingRecord = {
      ...initialRecord,
      status: "upgrade_pending",
      version: targetManifest.version,
      manifestJson: targetManifest,
    };
    const readyRecord = { ...pendingRecord, status: "ready" };
    const errorRecord = { ...initialRecord, status: "error" };
    mockRegistry.getById.mockResolvedValue(initialRecord);
    mockRegistry.updateStatus.mockImplementation(async (_id, input) => {
      if (input.status === "upgrade_pending") return pendingRecord;
      if (input.status === "error") return errorRecord;
      return readyRecord;
    });

    const loader: Partial<PluginLoader> = {
      hasRuntimeServices: vi.fn().mockReturnValue(true) as PluginLoader["hasRuntimeServices"],
      unloadSingle: vi.fn().mockResolvedValue(undefined) as PluginLoader["unloadSingle"],
      loadSingle: vi.fn().mockResolvedValue({
        success: true,
        plugin: readyRecord,
        registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
      }) as PluginLoader["loadSingle"],
      upgradePlugin: (options?.failure
        ? vi.fn().mockRejectedValue(options.failure)
        : vi.fn().mockResolvedValue({ oldManifest, newManifest: targetManifest, discovered: { ...discovered, manifest: targetManifest } })) as PluginLoader["upgradePlugin"],
    };
    const lifecycle = pluginLifecycleManager({} as never, { loader: loader as PluginLoader });
    return { lifecycle, loader, pendingRecord, readyRecord, errorRecord };
  }

  it("activates a validated upgrade directly when capabilities do not escalate", async () => {
    const { lifecycle, loader, readyRecord } = setupUpgrade();

    await expect(lifecycle.upgrade("plugin-1", "1.1.0")).resolves.toEqual(readyRecord);

    expect(loader.unloadSingle).toHaveBeenCalledWith("plugin-1", "example.plugin");
    expect(loader.upgradePlugin).toHaveBeenCalledWith("plugin-1", { version: "1.1.0" });
    expect(mockRegistry.updateStatus).toHaveBeenCalledWith("plugin-1", { status: "ready", lastError: null });
    expect(loader.loadSingle).toHaveBeenCalledWith("plugin-1");
  });

  it("persists an escalation as upgrade_pending and leaves the new runtime stopped", async () => {
    const { lifecycle, loader, pendingRecord } = setupUpgrade({
      addedCapabilities: ["tools.profile.invoke"],
    });

    await expect(lifecycle.upgrade("plugin-1", "1.1.0")).resolves.toEqual(pendingRecord);

    expect(loader.unloadSingle).toHaveBeenCalledWith("plugin-1", "example.plugin");
    expect(mockRegistry.updateStatus).toHaveBeenCalledWith("plugin-1", {
      status: "upgrade_pending",
      lastError: null,
    });
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(mockRegistry.install).not.toHaveBeenCalled();
  });

  it("activates the pending manifest only through enable approval", async () => {
    const { lifecycle, loader, readyRecord } = setupUpgrade({
      addedCapabilities: ["tools.profile.invoke"],
      initialStatus: "upgrade_pending",
    });

    await expect(lifecycle.enable("plugin-1")).resolves.toEqual(readyRecord);

    expect(mockRegistry.updateStatus).toHaveBeenCalledWith("plugin-1", { status: "ready", lastError: null });
    expect(loader.loadSingle).toHaveBeenCalledWith("plugin-1");
    expect(loader.upgradePlugin).not.toHaveBeenCalled();
  });

  it.each([
    ["manifest ID mismatch", new Error("new manifest ID does not match existing plugin ID")],
    ["failed package fetch", new Error("Local plugin path does not exist")],
  ])("keeps the worker stopped and records an error after %s", async (_label, failure) => {
    const { lifecycle, loader } = setupUpgrade({ failure });

    await expect(lifecycle.upgrade("plugin-1", "1.1.0")).rejects.toThrow(failure.message);

    expect(loader.unloadSingle).toHaveBeenCalledWith("plugin-1", "example.plugin");
    expect(mockRegistry.updateStatus).toHaveBeenCalledWith("plugin-1", {
      status: "error",
      lastError: `Upgrade failed: ${failure.message}`,
    });
    expect(loader.loadSingle).not.toHaveBeenCalled();
  });
});
