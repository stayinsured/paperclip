import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { paperclipConfigSchema } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import {
  buildIsolatedRuntimePaperclipConfig,
  computeIsolatedSeedExcludeTables,
  ensureIsolatedPaperclipRuntimeDatabase,
  findPaperclipServerRepoRoot,
} from "../services/isolated-runtime-database.js";

function fakeDbWithForeignKeys(rows: Array<{ child_table: string; parent_table: string }>): Db {
  return {
    execute: async () => rows,
  } as unknown as Db;
}

async function makePaperclipServerCheckout(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sta2385-checkout-"));
  await fs.mkdir(path.join(root, "packages", "db"), { recursive: true });
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.writeFile(path.join(root, "packages", "db", "package.json"), "{}");
  await fs.writeFile(path.join(root, "server", "package.json"), "{}");
  return root;
}

describe("findPaperclipServerRepoRoot", () => {
  it("locates the checkout root from the repo root and from nested service directories", async () => {
    const root = await makePaperclipServerCheckout();
    expect(findPaperclipServerRepoRoot(root)).toBe(root);
    expect(findPaperclipServerRepoRoot(path.join(root, "server", "src"))).toBe(root);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns null for directories that are not Paperclip server checkouts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sta2385-plain-"));
    expect(findPaperclipServerRepoRoot(root)).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("computeIsolatedSeedExcludeTables", () => {
  it("extends the static exclude list with the transitive foreign-key child closure", async () => {
    const db = fakeDbWithForeignKeys([
      { child_table: "issue_comments", parent_table: "issues" },
      { child_table: "issue_comment_reactions", parent_table: "issue_comments" },
      { child_table: "companies", parent_table: "instance_settings" },
      { child_table: "agents", parent_table: "companies" },
    ]);

    const excluded = await computeIsolatedSeedExcludeTables(db);
    const excludedNames = new Set(excluded.map((name) => name.replace(/^public\./, "")));

    expect(excludedNames.has("issues")).toBe(true);
    expect(excludedNames.has("issue_comments")).toBe(true);
    expect(excludedNames.has("issue_comment_reactions")).toBe(true);
    // Parents of excluded tables stay included; unrelated edges are untouched.
    expect(excludedNames.has("companies")).toBe(false);
    expect(excludedNames.has("agents")).toBe(false);
    expect(excludedNames.has("instance_settings")).toBe(false);
    // Secret material is never seeded.
    expect(excludedNames.has("company_secrets")).toBe(true);
    expect(excludedNames.has("agent_api_keys")).toBe(false);
    // Gateway token verifiers (seeded for all companies, unscoped) and in-flight
    // OAuth handshake state (plaintext code verifiers) stay on the main plane.
    expect(excludedNames.has("tool_mcp_gateway_tokens")).toBe(true);
    expect(excludedNames.has("tool_oauth_states")).toBe(true);
    for (const name of excluded) {
      expect(name.startsWith("public.")).toBe(true);
    }
  });
});

describe("buildIsolatedRuntimePaperclipConfig", () => {
  it("produces a schema-valid config with all state redirected under the worktree", () => {
    const runtimeDir = path.join("/wt", ".paperclip");
    const config = buildIsolatedRuntimePaperclipConfig({
      runtimeDir,
      dataDir: path.join(runtimeDir, "db"),
      databasePort: 54340,
    }) as Record<string, any>;

    // Must parse against the real schema so the booted server never trips on
    // config validation at startup.
    expect(() => paperclipConfigSchema.parse(config)).not.toThrow();

    expect(config.database.mode).toBe("embedded-postgres");
    expect(config.database.embeddedPostgresDataDir).toBe(path.join(runtimeDir, "db"));
    expect(config.database.embeddedPostgresPort).toBe(54340);
    expect(config.database.backup.enabled).toBe(false);
    expect(config.database.connectionString).toBeUndefined();
    expect(config.logging.logDir.startsWith(runtimeDir)).toBe(true);
    expect(config.storage.localDisk.baseDir.startsWith(runtimeDir)).toBe(true);
    expect(config.secrets.localEncrypted.keyFilePath.startsWith(runtimeDir)).toBe(true);
  });
});

describe("ensureIsolatedPaperclipRuntimeDatabase", () => {
  it("is a no-op for directories that are not Paperclip server checkouts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sta2385-plain-"));
    const result = await ensureIsolatedPaperclipRuntimeDatabase({ cwd: root, companyId: null });
    expect(result).toEqual({ applies: false, provisioned: false, configPath: null });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("short-circuits without provisioning when a worktree config already exists", async () => {
    const root = await makePaperclipServerCheckout();
    await fs.mkdir(path.join(root, ".paperclip"), { recursive: true });
    await fs.writeFile(path.join(root, ".paperclip", "config.json"), "{}");

    const result = await ensureIsolatedPaperclipRuntimeDatabase({ cwd: root, companyId: null });
    expect(result.applies).toBe(true);
    expect(result.provisioned).toBe(false);
    // No provisioning side effects were created alongside the existing config.
    await expect(fs.stat(path.join(root, ".paperclip", "db"))).rejects.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  });
});
