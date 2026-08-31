import { randomUUID } from "node:crypto";
import { logger } from "../middleware/logger.js";

export const SDLC_OBSERVABILITY_SCHEMA_VERSION = 1;
export const SDLC_LOKI_APP = "paperclip-sdlc-workflow";
export const SDLC_OBSERVABILITY_SINK_TIMEOUT_MS = 2_000;

export const SDLC_LIFECYCLE_EVENT_NAMES = [
  "lifecycle_class_assigned",
  "lifecycle_dor_validated",
  "lifecycle_gate_requested",
  "lifecycle_gate_decided",
  "lifecycle_provisioning_write",
  "lifecycle_provisioning_readback",
  "lifecycle_task_activated",
  "lifecycle_transition_forbidden",
  "lifecycle_bypass_detected",
  "lifecycle_provider_outage",
  "lifecycle_reconciliation_scan",
  "lifecycle_drift_detected",
  "lifecycle_drift_repaired",
  "lifecycle_emergency_used",
  "lifecycle_emergency_backfilled",
  "lifecycle_dod_evaluated",
  "lifecycle_closure_granted",
  "lifecycle_waiver_recorded",
  "lifecycle_scope_violation",
] as const;

export type SdlcLifecycleEventName = (typeof SDLC_LIFECYCLE_EVENT_NAMES)[number];
export type SdlcLifecyclePhase =
  | "planning"
  | "approval"
  | "provisioning"
  | "execution"
  | "reconciliation"
  | "release"
  | "closeout"
  | "emergency"
  | "guard";

export type SdlcLifecycleEventInput = {
  event: SdlcLifecycleEventName;
  companyId: string;
  issueId: string;
  phase: SdlcLifecyclePhase;
  riskClass?: "C1" | "C2" | "C3" | null;
  correlationId: string;
  actorRunId?: string | null;
  provider?: string | null;
  op?: string | null;
  outcome?: string | null;
  errorClass?: string | null;
  durationMs?: number | null;
  mismatchAgeSeconds?: number | null;
  retryCount?: number | null;
  captureInSentry?: boolean;
};

export type SdlcLifecycleEvent = {
  schemaVersion: typeof SDLC_OBSERVABILITY_SCHEMA_VERSION;
  event: SdlcLifecycleEventName;
  occurredAt: string;
  companyId: string;
  issueId: string;
  phase: SdlcLifecyclePhase;
  riskClass: "C1" | "C2" | "C3" | null;
  correlationId: string;
  actorRunId: string | null;
  provider: string | null;
  op: string | null;
  outcome: string | null;
  errorClass: string | null;
  durationMs: number | null;
  mismatchAgeSeconds: number | null;
  retryCount: number | null;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type SdlcObservabilityEnv = Record<string, string | undefined>;
type SdlcSinkResult = "sent" | "disabled" | "failed";

async function fetchSdlcSink(
  fetchImpl: FetchLike,
  input: string | URL | Request,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SDLC_OBSERVABILITY_SINK_TIMEOUT_MS);
  timeout.unref?.();
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/;
const SAFE_ENVIRONMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const EVENT_NAME_SET = new Set<string>(SDLC_LIFECYCLE_EVENT_NAMES);

function safeUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

function safeToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return SAFE_TOKEN_RE.test(trimmed) ? trimmed : null;
}

function safeCount(value: unknown, maximum: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
    ? Math.round(value)
    : null;
}

function safeEnvironment(value: unknown): string {
  if (typeof value !== "string") return "development";
  const trimmed = value.trim();
  return SAFE_ENVIRONMENT_RE.test(trimmed) ? trimmed : "development";
}

export function buildSdlcLifecycleEvent(
  input: SdlcLifecycleEventInput,
  occurredAt = new Date(),
): SdlcLifecycleEvent | null {
  const companyId = safeUuid(input.companyId);
  const issueId = safeUuid(input.issueId);
  const correlationId = safeToken(input.correlationId);
  if (!companyId || !issueId || !correlationId || !EVENT_NAME_SET.has(input.event)) return null;

  return {
    schemaVersion: SDLC_OBSERVABILITY_SCHEMA_VERSION,
    event: input.event,
    occurredAt: occurredAt.toISOString(),
    companyId,
    issueId,
    phase: input.phase,
    riskClass: input.riskClass === "C1" || input.riskClass === "C2" || input.riskClass === "C3"
      ? input.riskClass
      : null,
    correlationId,
    actorRunId: safeUuid(input.actorRunId),
    provider: safeToken(input.provider),
    op: safeToken(input.op),
    outcome: safeToken(input.outcome),
    errorClass: safeToken(input.errorClass),
    durationMs: safeCount(input.durationMs, 86_400_000),
    mismatchAgeSeconds: safeCount(input.mismatchAgeSeconds, 31_536_000),
    retryCount: safeCount(input.retryCount, 1_000),
  };
}

function lokiPushUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return null;
    if (!parsed.pathname.endsWith("/loki/api/v1/push")) {
      parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/loki/api/v1/push`;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed;
  } catch {
    return null;
  }
}

export async function sendSdlcEventToLoki(
  event: SdlcLifecycleEvent,
  options: { fetchImpl?: FetchLike; env?: SdlcObservabilityEnv } = {},
): Promise<SdlcSinkResult> {
  const env = options.env ?? process.env;
  const endpoint = env.PAPERCLIP_SDLC_LOKI_URL?.trim();
  const user = env.PAPERCLIP_SDLC_LOKI_USER?.trim();
  const token = env.PAPERCLIP_SDLC_LOKI_TOKEN?.trim();
  if (!endpoint || !user || !token) return "disabled";
  const url = lokiPushUrl(endpoint);
  if (!url) return "failed";

  const environment = safeEnvironment(env.PAPERCLIP_SDLC_ENVIRONMENT);
  const timestampNs = `${BigInt(Date.parse(event.occurredAt)) * 1_000_000n}`;
  try {
    const response = await fetchSdlcSink(options.fetchImpl ?? fetch, url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        streams: [{
          stream: {
            app: SDLC_LOKI_APP,
            service_name: SDLC_LOKI_APP,
            environment,
          },
          values: [[timestampNs, JSON.stringify(event)]],
        }],
      }),
    });
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

function sentryStoreTarget(dsnValue: string): { url: URL; publicKey: string } | null {
  try {
    const dsn = new URL(dsnValue);
    if (dsn.protocol !== "https:" || dsn.password || dsn.search || dsn.hash) return null;
    const publicKey = dsn.username;
    const pathParts = dsn.pathname.split("/").filter(Boolean);
    const projectId = pathParts.pop();
    if (!publicKey || !projectId || !/^\d+$/.test(projectId)) return null;
    const prefix = pathParts.length > 0 ? `/${pathParts.join("/")}` : "";
    return {
      url: new URL(`${prefix}/api/${projectId}/store/`, dsn.origin),
      publicKey,
    };
  } catch {
    return null;
  }
}

export async function sendSdlcFailureToSentry(
  event: SdlcLifecycleEvent,
  options: { fetchImpl?: FetchLike; env?: SdlcObservabilityEnv } = {},
): Promise<SdlcSinkResult> {
  const env = options.env ?? process.env;
  const dsn = env.PAPERCLIP_SDLC_SENTRY_DSN?.trim();
  if (!dsn) return "disabled";
  const target = sentryStoreTarget(dsn);
  if (!target || !event.errorClass) return "failed";

  const environment = safeEnvironment(env.PAPERCLIP_SDLC_ENVIRONMENT);
  const tags = {
    event: event.event,
    phase: event.phase,
    risk_class: event.riskClass ?? "unknown",
    provider: event.provider ?? "none",
    operation: event.op ?? "none",
    outcome: event.outcome ?? "failure",
  };
  const payload = {
    event_id: randomUUID().replaceAll("-", ""),
    timestamp: event.occurredAt,
    platform: "node",
    level: "error",
    logger: "paperclip.sdlc",
    environment,
    message: `SDLC workflow failure: ${event.errorClass}`,
    tags,
    extra: {
      schemaVersion: event.schemaVersion,
      companyId: event.companyId,
      issueId: event.issueId,
      correlationId: event.correlationId,
      actorRunId: event.actorRunId,
      durationMs: event.durationMs,
      mismatchAgeSeconds: event.mismatchAgeSeconds,
      retryCount: event.retryCount,
    },
  };
  try {
    const response = await fetchSdlcSink(options.fetchImpl ?? fetch, target.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${target.publicKey}, sentry_client=paperclip-sdlc/1.0`,
      },
      body: JSON.stringify(payload),
    });
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

export async function emitSdlcLifecycleEvent(input: SdlcLifecycleEventInput): Promise<SdlcLifecycleEvent | null> {
  const event = buildSdlcLifecycleEvent(input);
  if (!event) return null;
  logger.info({ sdlcEvent: event }, "sdlc_lifecycle_event");

  const writes: Array<Promise<SdlcSinkResult>> = [sendSdlcEventToLoki(event)];
  if (input.captureInSentry) writes.push(sendSdlcFailureToSentry(event));
  const results = await Promise.allSettled(writes);
  if (results.some((result) => result.status === "rejected" || result.value === "failed")) {
    logger.warn({ event: event.event, correlationId: event.correlationId }, "sdlc_observability_sink_failed");
  }
  return event;
}

const RECORD_EVENT_MAP: Readonly<Record<string, { event: SdlcLifecycleEventName; phase: SdlcLifecyclePhase }>> = {
  classification: { event: "lifecycle_class_assigned", phase: "planning" },
  dor_validated: { event: "lifecycle_dor_validated", phase: "planning" },
  gate_request: { event: "lifecycle_gate_requested", phase: "approval" },
  gate_decision: { event: "lifecycle_gate_decided", phase: "approval" },
  provisioning_write: { event: "lifecycle_provisioning_write", phase: "provisioning" },
  provider_readback: { event: "lifecycle_provisioning_readback", phase: "provisioning" },
  activation: { event: "lifecycle_task_activated", phase: "execution" },
  bypass_detected: { event: "lifecycle_bypass_detected", phase: "guard" },
  provider_outage: { event: "lifecycle_provider_outage", phase: "reconciliation" },
  reconciliation_summary: { event: "lifecycle_reconciliation_scan", phase: "reconciliation" },
  drift_detected: { event: "lifecycle_drift_detected", phase: "reconciliation" },
  drift_repaired: { event: "lifecycle_drift_repaired", phase: "reconciliation" },
  emergency: { event: "lifecycle_emergency_used", phase: "emergency" },
  emergency_backfilled: { event: "lifecycle_emergency_backfilled", phase: "emergency" },
  closure_decision: { event: "lifecycle_dod_evaluated", phase: "closeout" },
  closure_granted: { event: "lifecycle_closure_granted", phase: "closeout" },
  waiver: { event: "lifecycle_waiver_recorded", phase: "closeout" },
  scope_violation: { event: "lifecycle_scope_violation", phase: "guard" },
};

function recordString(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === "string" ? record[key] as string : null;
}

function recordNumber(record: Record<string, unknown>, key: string): number | null {
  return typeof record[key] === "number" ? record[key] as number : null;
}

export function lifecycleEventInputForEvidenceRecord(
  record: Record<string, unknown>,
  riskClass?: "C1" | "C2" | "C3" | null,
): SdlcLifecycleEventInput | null {
  const type = recordString(record, "type");
  const mapped = type ? RECORD_EVENT_MAP[type] : null;
  const companyId = recordString(record, "companyId");
  const issueId = recordString(record, "issueId");
  const correlationId = recordString(record, "id");
  if (!mapped || !companyId || !issueId || !correlationId) return null;
  const errorClass = recordString(record, "errorClass") ?? recordString(record, "code");
  return {
    ...mapped,
    companyId,
    issueId,
    correlationId,
    riskClass: riskClass ?? null,
    actorRunId: recordString(record, "actorRunId"),
    provider: recordString(record, "provider"),
    op: recordString(record, "op"),
    outcome: recordString(record, "outcome") ?? recordString(record, "verdict") ?? recordString(record, "result"),
    errorClass,
    durationMs: recordNumber(record, "durationMs"),
    mismatchAgeSeconds: recordNumber(record, "mismatchAgeSeconds"),
    retryCount: recordNumber(record, "retryCount"),
    captureInSentry: Boolean(errorClass) && (
      mapped.event === "lifecycle_bypass_detected"
      || mapped.event === "lifecycle_provider_outage"
      || mapped.event === "lifecycle_drift_detected"
      || mapped.event === "lifecycle_scope_violation"
    ),
  };
}
