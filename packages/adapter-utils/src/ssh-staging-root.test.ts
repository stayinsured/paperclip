import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSshSyncStagingRoot } from "./ssh.js";

async function withEnv<T>(
  values: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("resolveSshSyncStagingRoot", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("defaults to a tmp subtree of the instance data dir when configured", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-staging-root-"));
    cleanupDirs.push(dataDir);

    await withEnv({ PAPERCLIP_DATA_DIR: dataDir, PAPERCLIP_SSH_SYNC_STAGING_DIR: undefined }, () => {
      const resolved = resolveSshSyncStagingRoot();
      expect(resolved.root).toBe(path.join(dataDir, "tmp", "ssh-sync-staging"));
      expect(resolved.explicit).toBe(false);
    });
  });

  it("prefers the explicit operator override over the data dir", async () => {
    const overrideDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-staging-override-"));
    cleanupDirs.push(overrideDir);
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-staging-data-"));
    cleanupDirs.push(dataDir);

    await withEnv(
      {
        PAPERCLIP_DATA_DIR: dataDir,
        PAPERCLIP_SSH_SYNC_STAGING_DIR: path.join(overrideDir, "nested", "root"),
      },
      () => {
        const resolved = resolveSshSyncStagingRoot();
        expect(resolved.root).toBe(path.join(overrideDir, "nested", "root"));
        expect(resolved.explicit).toBe(true);
      },
    );
  });

  it("falls back to os.tmpdir() when neither variable is set", async () => {
    await withEnv({ PAPERCLIP_DATA_DIR: undefined, PAPERCLIP_SSH_SYNC_STAGING_DIR: undefined }, () => {
      const resolved = resolveSshSyncStagingRoot();
      expect(resolved.root).toBe(os.tmpdir());
      expect(resolved.explicit).toBe(false);
    });
  });
});
