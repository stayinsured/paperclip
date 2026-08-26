import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const dueJob = {
  id: "job-1",
  pluginId: "plugin-1",
  jobKey: "sentry-poll",
  schedule: "* * * * *",
  status: "active",
  config: {},
  nextRunAt: new Date(Date.now() - 60_000),
  lastRunAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createHarness() {
  let workerRunning = false;
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [dueJob]),
      })),
    })),
  } as unknown as Db;
  const jobStore = {
    createRun: vi.fn(async () => ({ id: "run-1" })),
    markRunning: vi.fn(async () => undefined),
    completeRun: vi.fn(async () => undefined),
    updateRunTimestamps: vi.fn(async () => undefined),
  } as unknown as PluginJobStore;
  const workerManager = {
    isRunning: vi.fn(() => workerRunning),
    call: vi.fn(async () => undefined),
  } as unknown as PluginWorkerManager;

  return {
    db,
    jobStore,
    workerManager,
    markWorkerRunning: () => {
      workerRunning = true;
    },
  };
}

describe("PluginJobScheduler missing-worker recovery", () => {
  it("recovers a missing managed worker before dispatching a due job", async () => {
    const harness = createHarness();
    const recoverMissingWorker = vi.fn(async () => {
      harness.markWorkerRunning();
      return true;
    });
    const scheduler = createPluginJobScheduler({
      db: harness.db,
      jobStore: harness.jobStore,
      workerManager: harness.workerManager,
      recoverMissingWorker,
    });

    await scheduler.tick();

    expect(recoverMissingWorker).toHaveBeenCalledTimes(1);
    expect(recoverMissingWorker).toHaveBeenCalledWith(dueJob.pluginId);
    expect(harness.jobStore.createRun).toHaveBeenCalledWith({
      jobId: dueJob.id,
      pluginId: dueJob.pluginId,
      trigger: "schedule",
    });
    expect(harness.workerManager.call).toHaveBeenCalledWith(
      dueJob.pluginId,
      "runJob",
      {
        job: expect.objectContaining({
          jobKey: dueJob.jobKey,
          runId: "run-1",
          trigger: "schedule",
        }),
      },
      5 * 60 * 1_000,
    );
    expect(harness.jobStore.completeRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "succeeded" }),
    );
    expect(harness.jobStore.updateRunTimestamps).toHaveBeenCalledWith(
      dueJob.id,
      expect.any(Date),
      expect.any(Date),
    );
  });

  it("keeps a due job undispatched when the missing worker cannot be recovered", async () => {
    const harness = createHarness();
    const recoverMissingWorker = vi.fn(async () => false);
    const scheduler = createPluginJobScheduler({
      db: harness.db,
      jobStore: harness.jobStore,
      workerManager: harness.workerManager,
      recoverMissingWorker,
    });

    await scheduler.tick();

    expect(recoverMissingWorker).toHaveBeenCalledWith(dueJob.pluginId);
    expect(harness.jobStore.createRun).not.toHaveBeenCalled();
    expect(harness.workerManager.call).not.toHaveBeenCalled();
    expect(harness.jobStore.updateRunTimestamps).not.toHaveBeenCalled();
  });
});
