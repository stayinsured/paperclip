import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { sql } from "drizzle-orm";
import { paperclipConfigSchema } from "@paperclipai/shared";
import {
  createDb,
  ensurePostgresDatabase,
  resolveDatabaseTarget,
  runDatabaseBackup,
  runDatabaseRestore,
  type Db,
} from "@paperclipai/db";
import { loadWithoutCoordinatedShutdownSignalHooks } from "../shutdown.js";

/**
 * STA-2385: isolated runtime services that boot a Paperclip control-plane
 * server from an execution-workspace worktree previously inherited no database
 * configuration at all. The sanitized service environment (no DATABASE_URL, no
 * PAPERCLIP_*) made the booted server fall back to the HOME-shared embedded
 * PostgreSQL instance, which has no agent_api_keys rows, so every main-plane
 * agent API key was rejected with 401 before any clone readback could run.
 *
 * This module provisions, once per worktree, a dedicated embedded PostgreSQL
 * cluster seeded from the running instance database (volatile tables and
 * secret material excluded) plus a `.paperclip/config.json` that the booted
 * server resolves via its ancestor config search. Main-plane secrets never
 * enter the service environment; only the task-scoped worktree receives state.
 */

const EMBEDDED_POSTGRES_USER = "paperclip";
const EMBEDDED_POSTGRES_PASSWORD = "paperclip";
const EMBEDDED_POSTGRES_DATABASE = "paperclip";

const PROVISIONING_LOCK_STALE_MS = 15 * 60_000;
const PROVISIONING_LOCK_TIMEOUT_MS = 10 * 60_000;

/**
 * Tables whose data must not be carried into an isolated runtime. Volatile
 * run/session state, issue activity, credentials, and encrypted secret
 * material stay on the main plane. `computeIsolatedSeedExcludeTables` extends
 * this list with every child table (transitive FK closure) so the seeded
 * database never contains rows referencing an excluded parent.
 */
const ISOLATED_SEED_EXCLUDED_TABLES: readonly string[] = [
  "account",
  "activity_log",
  "agent_config_revisions",
  "agent_runtime_state",
  "agent_task_sessions",
  "agent_wakeup_requests",
  "assets",
  "cli_auth_challenges",
  "company_secret_bindings",
  "company_secret_provider_configs",
  "company_secret_versions",
  "company_secrets",
  "company_user_sidebar_preferences",
  "cost_events",
  "documents",
  "environment_custom_image_setup_sessions",
  "environment_leases",
  "execution_workspaces",
  "feedback_exports",
  "feedback_votes",
  "finance_events",
  "heartbeat_run_events",
  "heartbeat_run_watchdog_decisions",
  "heartbeat_runs",
  "inbox_dismissals",
  "invites",
  "issue_create_idempotency_keys",
  "issue_inbox_archives",
  "issue_read_states",
  "issues",
  "join_requests",
  "session",
  "tool_mcp_gateway_tokens",
  "tool_oauth_states",
  "verification",
  "workspace_runtime_services",
];

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type IsolatedRuntimeDatabaseEnsureResult = {
  /** True when the cwd belongs to a Paperclip server checkout eligible for provisioning. */
  applies: boolean;
  /** True when this call performed the seed; false when a config already existed. */
  provisioned: boolean;
  configPath: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate port"));
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

/**
 * Locate the root of a Paperclip control-plane checkout starting from (and
 * including) `startDir`. Service working directories may be subdirectories of
 * the worktree, while the config file must land at the repo root for the
 * booted server's ancestor `.paperclip/config.json` search to find it.
 */
export function findPaperclipServerRepoRoot(startDir: string): string | null {
  let currentDir = path.resolve(startDir);
  while (true) {
    if (
      existsSync(path.join(currentDir, "packages", "db", "package.json")) &&
      existsSync(path.join(currentDir, "server", "package.json"))
    ) {
      return currentDir;
    }
    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) return null;
    currentDir = nextDir;
  }
}

function resolveSourceDatabaseUrl(): string {
  const target = resolveDatabaseTarget();
  if (target.mode === "postgres") {
    return target.connectionString;
  }
  return embeddedConnectionString(target.port, EMBEDDED_POSTGRES_DATABASE);
}

function embeddedConnectionString(port: number, database: string): string {
  return `postgres://${EMBEDDED_POSTGRES_USER}:${EMBEDDED_POSTGRES_PASSWORD}@127.0.0.1:${port}/${database}`;
}

/**
 * Extend the static exclude list with every table that has (transitively) a
 * foreign key onto an excluded table, so included data never dangles. The FK
 * edges come from the live source database, not a hardcoded schema snapshot.
 */
export async function computeIsolatedSeedExcludeTables(db: Db): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT src.relname AS child_table, tgt.relname AS parent_table
    FROM pg_constraint c
    JOIN pg_class src ON src.oid = c.conrelid
    JOIN pg_namespace srcn ON srcn.oid = src.relnamespace
    JOIN pg_class tgt ON tgt.oid = c.confrelid
    JOIN pg_namespace tgtn ON tgtn.oid = tgt.relnamespace
    WHERE c.contype = 'f'
      AND srcn.nspname = 'public'
      AND tgtn.nspname = 'public'
  `);
  const childrenByParent = new Map<string, Set<string>>();
  for (const row of rows as unknown as Array<{ child_table: string; parent_table: string }>) {
    let children = childrenByParent.get(row.parent_table);
    if (!children) {
      children = new Set<string>();
      childrenByParent.set(row.parent_table, children);
    }
    children.add(row.child_table);
  }

  const excluded = new Set<string>(ISOLATED_SEED_EXCLUDED_TABLES);
  const queue = [...excluded];
  while (queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) break;
    for (const child of childrenByParent.get(parent) ?? []) {
      if (excluded.has(child)) continue;
      excluded.add(child);
      queue.push(child);
    }
  }

  return Array.from(excluded, (name) => `public.${name}`).sort();
}

/**
 * Build the worktree-local config consumed by the isolated server. Everything
 * stateful is redirected under the worktree's gitignored `.paperclip/` dir so
 * concurrently running isolated runtimes never share logs, storage, secrets,
 * or a database cluster. The `server` section keeps code defaults: the runtime
 * service still controls the listen port via the PORT environment variable and
 * dev-runner flags still override deployment mode, exactly as before.
 */
export function buildIsolatedRuntimePaperclipConfig(input: {
  runtimeDir: string;
  dataDir: string;
  databasePort: number;
}): Record<string, unknown> {
  const config = {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: input.dataDir,
      embeddedPostgresPort: input.databasePort,
      backup: {
        enabled: false,
        intervalMinutes: 60,
        retentionDays: 1,
        dir: path.join(input.runtimeDir, "data", "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(input.runtimeDir, "logs"),
    },
    server: {
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    telemetry: {
      enabled: false,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: true,
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: path.join(input.runtimeDir, "data", "storage"),
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(input.runtimeDir, "secrets", "master.key"),
      },
    },
  };
  // Validate before writing so a schema drift fails provisioning loudly
  // instead of bricking the isolated server at boot.
  paperclipConfigSchema.parse(config);
  return config;
}

function writeIsolatedRuntimeConfigFile(input: {
  configPath: string;
  runtimeDir: string;
  dataDir: string;
  databasePort: number;
}): void {
  const config = buildIsolatedRuntimePaperclipConfig(input);
  mkdirSync(path.dirname(input.configPath), { recursive: true });
  const temporaryPath = `${input.configPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, input.configPath);
}

async function withProvisioningLock<T>(lockDir: string, run: () => Promise<T>): Promise<T> {
  mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + PROVISIONING_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as { code?: string }).code : null;
      if (code !== "EEXIST") throw error;
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > PROVISIONING_LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for isolated-runtime database provisioning lock at ${lockDir}`);
      }
      await sleep(250);
    }
  }
  try {
    return await run();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

async function loadEmbeddedPostgresConstructor(): Promise<EmbeddedPostgresCtor> {
  // embedded-postgres registers async exit hooks on import; load it without
  // them for the same reasons as the main startup path (see server/src/index.ts).
  const mod = await loadWithoutCoordinatedShutdownSignalHooks(() => import("embedded-postgres"));
  return mod.default as EmbeddedPostgresCtor;
}

/**
 * Ensure an isolated runtime service that boots a Paperclip control-plane
 * server from `cwd` gets a dedicated, seeded database cluster and a
 * worktree-local config. Idempotent: an existing `.paperclip/config.json`
 * short-circuits, and a filesystem lock serializes concurrent starts.
 */
export async function ensureIsolatedPaperclipRuntimeDatabase(input: {
  cwd: string;
  companyId: string | null;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<IsolatedRuntimeDatabaseEnsureResult> {
  const repoRoot = findPaperclipServerRepoRoot(input.cwd);
  if (!repoRoot) {
    return { applies: false, provisioned: false, configPath: null };
  }

  const runtimeDir = path.join(repoRoot, ".paperclip");
  const configPath = path.join(runtimeDir, "config.json");
  if (existsSync(configPath)) {
    return { applies: true, provisioned: false, configPath };
  }

  const log = async (line: string) => {
    if (input.onLog) {
      await input.onLog("stdout", `[isolated-runtime-db] ${line}\n`);
    }
  };

  return await withProvisioningLock(path.join(runtimeDir, "runtime-db.lock"), async () => {
    if (existsSync(configPath)) {
      return { applies: true, provisioned: false, configPath };
    }

    const dataDir = path.join(runtimeDir, "db");
    const provisioningDir = path.join(runtimeDir, "provisioning");
    const sourceUrl = resolveSourceDatabaseUrl();
    const databasePort = await allocateLoopbackPort();

    try {
      await log("provisioning dedicated database for isolated runtime...");
      const sourceDb = createDb(sourceUrl, {
        maxConnections: 1,
        idleTimeoutSeconds: 1,
        connectTimeoutSeconds: 10,
      });
      let excludeTables: string[];
      try {
        excludeTables = await computeIsolatedSeedExcludeTables(sourceDb);
      } finally {
        await closeDb(sourceDb);
      }

      const backup = await runDatabaseBackup({
        connectionString: sourceUrl,
        backupDir: provisioningDir,
        retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
        filenamePrefix: "isolated-runtime-seed",
        excludeTables,
      });
      await log(`seed snapshot ready (${excludeTables.length} tables excluded)`);

      const EmbeddedPostgres = await loadEmbeddedPostgresConstructor();
      const instance = new EmbeddedPostgres({
        databaseDir: dataDir,
        user: EMBEDDED_POSTGRES_USER,
        password: EMBEDDED_POSTGRES_PASSWORD,
        port: databasePort,
        persistent: true,
        initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      });
      await instance.initialise();
      await instance.start();
      try {
        const adminUrl = embeddedConnectionString(databasePort, "postgres");
        await ensurePostgresDatabase(adminUrl, EMBEDDED_POSTGRES_DATABASE);
        const targetUrl = embeddedConnectionString(databasePort, EMBEDDED_POSTGRES_DATABASE);
        await runDatabaseRestore({
          connectionString: targetUrl,
          backupFile: backup.backupFile,
          connectTimeoutSeconds: 10,
        });

        if (input.companyId) {
          const targetDb = createDb(targetUrl, {
            maxConnections: 1,
            idleTimeoutSeconds: 1,
            connectTimeoutSeconds: 10,
          });
          try {
            // Task-scoped key material: only the company owning this isolated
            // runtime keeps verifiable agent API keys in the seeded database.
            await targetDb.execute(
              sql`DELETE FROM agent_api_keys WHERE company_id <> ${input.companyId}`,
            );
          } finally {
            await closeDb(targetDb);
          }
        }
      } finally {
        await instance.stop();
      }

      writeIsolatedRuntimeConfigFile({ configPath, runtimeDir, dataDir, databasePort });
      await log(`seeded isolated runtime database (port ${databasePort})`);
      return { applies: true, provisioned: true, configPath };
    } catch (error) {
      rmSync(dataDir, { recursive: true, force: true });
      throw error;
    } finally {
      rmSync(provisioningDir, { recursive: true, force: true });
    }
  });
}

async function closeDb(db: Db): Promise<void> {
  const maybeEnd = (db as unknown as { $client?: { end?: () => Promise<unknown> } }).$client;
  if (maybeEnd && typeof maybeEnd.end === "function") {
    await maybeEnd.end();
  }
}
