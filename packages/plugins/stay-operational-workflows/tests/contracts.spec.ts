import { describe, expect, it } from "vitest";
import {
  candidateFromIssueRow,
  classifyFailure,
  createRedactedReceipt,
  deterministicOperationKey,
  parseModuleConfig,
  type ModuleConfig,
  type SourceCandidate,
} from "../src/contracts.js";

const config: ModuleConfig = {
  companyId: "company-a",
  projectId: "project-a",
  module: "outline",
  enabled: true,
  readOnly: true,
  destinationEnabled: false,
  destinationKey: "digital/architecture",
  sourceVersion: "paperclip-v1",
  policyVersion: "shadow-v1",
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  overlapSeconds: 300,
  batchSize: 200,
};

const candidate: SourceCandidate = {
  companyId: "company-a",
  projectId: "project-a",
  module: "outline",
  sourceKind: "paperclip_issue",
  sourceId: "issue-a",
  sourceVersion: "paperclip-v1:abc",
  policyVersion: "shadow-v1",
  cursorValue: "2026-08-07T10:00:00.000Z|issue-a",
  sourceStatus: "done",
};

describe("shadow contracts", () => {
  it("creates stable operation keys scoped by company, module, source, and policy", () => {
    const first = deterministicOperationKey(candidate);
    expect(deterministicOperationKey({ ...candidate })).toBe(first);
    expect(deterministicOperationKey({ ...candidate, companyId: "company-b" })).not.toBe(first);
    expect(deterministicOperationKey({ ...candidate, module: "clickup" })).not.toBe(first);
    expect(deterministicOperationKey({ ...candidate, policyVersion: "shadow-v2" })).not.toBe(first);
    expect(deterministicOperationKey({ ...candidate, sourceVersion: "paperclip-v1:def" })).not.toBe(first);
  });

  it("keeps module switches independent while failing closed on external writes", () => {
    expect(parseModuleConfig({
      companyId: "company-a",
      projectId: "project-a",
      module: "clickup",
      enabled: true,
      readOnly: true,
      destinationEnabled: false,
      destinationKey: "digital-list",
    })).toMatchObject({
      module: "clickup",
      enabled: true,
      readOnly: true,
      destinationEnabled: false,
      destinationKey: "digital-list",
    });

    expect(() => parseModuleConfig({
      companyId: "company-a",
      projectId: "project-a",
      module: "outline",
      enabled: true,
      readOnly: false,
      destinationEnabled: false,
    })).toThrow(/shadow-only/);
    expect(() => parseModuleConfig({
      companyId: "company-a",
      projectId: "project-a",
      module: "sentry_slack",
      enabled: true,
      destinationEnabled: true,
    })).toThrow(/shadow-only/);
  });

  it("constructs source candidates from an allowlist and drops raw PII/provider fields", () => {
    const secret = "Bearer top-secret-token";
    const email = "customer@example.com";
    const result = candidateFromIssueRow({
      id: "issue-a",
      company_id: "company-a",
      project_id: "project-a",
      status: "done",
      updated_at: "2026-08-07T10:00:00.000Z",
      title: email,
      description: secret,
      raw_provider_payload: { authorization: secret },
    }, config);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(email);
    expect(result).toEqual(expect.objectContaining({
      companyId: "company-a",
      projectId: "project-a",
      sourceId: "issue-a",
      sourceStatus: "done",
    }));
  });

  it("rejects rows outside the configured company or project", () => {
    expect(() => candidateFromIssueRow({
      id: "issue-a",
      company_id: "company-b",
      project_id: "project-a",
      status: "done",
      updated_at: "2026-08-07T10:00:00.000Z",
    }, config)).toThrow(/boundary/);
    expect(() => candidateFromIssueRow({
      id: "issue-a",
      company_id: "company-a",
      project_id: "project-b",
      status: "done",
      updated_at: "2026-08-07T10:00:00.000Z",
    }, config)).toThrow(/boundary/);
  });

  it("produces a fixed allowlisted receipt without provider payload or PII", () => {
    const receipt = createRedactedReceipt({
      operationKey: deterministicOperationKey(candidate),
      category: "shadow",
      code: "candidate_observed",
      status: "done",
      occurredAt: "2026-08-07T10:00:00.000Z",
    });
    expect(receipt).toEqual({
      schemaVersion: 1,
      category: "shadow",
      code: "candidate_observed",
      status: "done",
      occurredAt: "2026-08-07T10:00:00.000Z",
      outcomeIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      externalWriteAttempted: false,
    });
  });

  it("classifies ambiguous timeout, auth, schema, 429, and 5xx failures safely", () => {
    const now = new Date("2026-08-07T10:00:00.000Z");
    expect(classifyFailure({ kind: "ambiguous_timeout" }, 1, config, now)).toEqual({
      status: "reconciling",
      exceptionKind: "ambiguous_timeout",
      retryAt: null,
    });
    expect(classifyFailure({ kind: "invalid_schema" }, 1, config, now)).toEqual({
      status: "failed",
      exceptionKind: "invalid_schema",
      retryAt: null,
    });
    expect(classifyFailure({ httpStatus: 401 }, 1, config, now)).toEqual({
      status: "failed",
      exceptionKind: "revoked_credential",
      retryAt: null,
    });
    expect(classifyFailure({ httpStatus: 429 }, 1, config, now)).toEqual({
      status: "retry_wait",
      exceptionKind: "rate_limited",
      retryAt: "2026-08-07T10:00:01.000Z",
    });
    expect(classifyFailure({ httpStatus: 503 }, 2, config, now)).toEqual({
      status: "retry_wait",
      exceptionKind: "provider_unavailable",
      retryAt: "2026-08-07T10:00:02.000Z",
    });
    expect(classifyFailure({ httpStatus: 503 }, 5, config, now)).toEqual({
      status: "failed",
      exceptionKind: "provider_unavailable",
      retryAt: null,
    });
  });
});
