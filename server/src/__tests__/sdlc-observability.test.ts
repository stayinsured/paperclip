import { describe, expect, it, vi } from "vitest";
import {
  buildSdlcLifecycleEvent,
  lifecycleEventInputForEvidenceRecord,
  sendSdlcEventToLoki,
  sendSdlcFailureToSentry,
} from "../services/sdlc-observability.ts";

const COMPANY_ID = "bc01148d-78ea-497c-8990-943eb6a7803e";
const ISSUE_ID = "5d681a24-d20d-415e-b135-dba9c9826fde";
const RUN_ID = "63b01f3e-5472-4d61-8f7c-6d29abe41ec8";

function failureEvent() {
  const event = buildSdlcLifecycleEvent({
    event: "lifecycle_provider_outage",
    companyId: COMPANY_ID,
    issueId: ISSUE_ID,
    phase: "reconciliation",
    riskClass: "C2",
    correlationId: `evd:provider-outage:${ISSUE_ID}`,
    actorRunId: RUN_ID,
    provider: "clickup",
    op: "readback",
    outcome: "failed",
    errorClass: "provider_unavailable",
    retryCount: 3,
  }, new Date("2026-08-31T15:00:00.000Z"));
  if (!event) throw new Error("expected valid event");
  return event;
}

describe("SDLC observability", () => {
  it("emits only allowlisted safe correlation fields", () => {
    const input = {
      event: "lifecycle_task_activated" as const,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      phase: "execution" as const,
      riskClass: "C2" as const,
      correlationId: `evd:activation:${ISSUE_ID}`,
      actorRunId: RUN_ID,
      provider: "contains customer@example.com",
      op: "activate",
      outcome: "success",
      customerEmail: "customer@example.com",
      documentBody: "private plan text",
      apiToken: "secret-token-value",
    };

    const event = buildSdlcLifecycleEvent(input);
    expect(event).toMatchObject({
      event: "lifecycle_task_activated",
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      phase: "execution",
      riskClass: "C2",
      actorRunId: RUN_ID,
      provider: null,
      op: "activate",
      outcome: "success",
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("customer@example.com");
    expect(serialized).not.toContain("private plan text");
    expect(serialized).not.toContain("secret-token-value");
  });

  it("rejects invalid identifiers instead of exporting partial events", () => {
    expect(buildSdlcLifecycleEvent({
      event: "lifecycle_gate_decided",
      companyId: "not-a-company-id",
      issueId: ISSUE_ID,
      phase: "approval",
      correlationId: "gate-decision",
    })).toBeNull();
  });

  it("pushes one JSON event to a low-cardinality Loki stream without credentials in the body", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await sendSdlcEventToLoki(failureEvent(), {
      fetchImpl,
      env: {
        PAPERCLIP_SDLC_LOKI_URL: "https://logs.example.test",
        PAPERCLIP_SDLC_LOKI_USER: "tenant-123",
        PAPERCLIP_SDLC_LOKI_TOKEN: "super-secret-loki-token",
        PAPERCLIP_SDLC_ENVIRONMENT: "test",
      },
    });

    expect(result).toBe("sent");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://logs.example.test/loki/api/v1/push");
    const body = String(init?.body);
    expect(body).toContain('"app":"paperclip-sdlc-workflow"');
    expect(body).toContain('"environment":"test"');
    expect(body).toContain('\\"event\\":\\"lifecycle_provider_outage\\"');
    expect(body).not.toContain("super-secret-loki-token");
    expect(body).not.toContain("tenant-123");
  });

  it("captures only classified failure metadata in Sentry", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const result = await sendSdlcFailureToSentry(failureEvent(), {
      fetchImpl,
      env: {
        PAPERCLIP_SDLC_SENTRY_DSN: "https://public-key@events.example.test/12345",
        PAPERCLIP_SDLC_ENVIRONMENT: "test",
      },
    });

    expect(result).toBe("sent");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://events.example.test/api/12345/store/");
    const body = String(init?.body);
    expect(body).toContain("SDLC workflow failure: provider_unavailable");
    expect(body).toContain(`"issueId":"${ISSUE_ID}"`);
    expect(body).toContain(`"correlationId":"evd:provider-outage:${ISSUE_ID}"`);
    expect(body).not.toContain("public-key");
    expect(body).not.toContain("exception");
    expect(body).not.toContain("stacktrace");
  });

  it("maps append-only evidence records to the contract event taxonomy", () => {
    expect(lifecycleEventInputForEvidenceRecord({
      id: `evd:gate2:${COMPANY_ID}:${ISSUE_ID}`,
      type: "gate_decision",
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      actorRunId: RUN_ID,
      verdict: "accepted",
    }, "C2")).toMatchObject({
      event: "lifecycle_gate_decided",
      phase: "approval",
      outcome: "accepted",
      riskClass: "C2",
      captureInSentry: false,
    });
  });
});
