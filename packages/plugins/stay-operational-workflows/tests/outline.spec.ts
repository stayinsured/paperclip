import { describe, expect, it } from "vitest";
import {
  OutlineAmbiguousWriteError,
  OutlineAssessmentCoordinator,
  type OutlineAssessmentRecord,
  type OutlineAssessmentRepository,
  deterministicOutlineDocumentId,
  outlineConfigurationFingerprint,
  publishOutlinePreview,
  renderOutlineShadowPreview,
  type OutlineMcpPort,
  type OutlineCompletionSource,
  type OutlineDestinationConfig,
  type OutlineDocument,
  type OutlineMaterialityAssessment,
  type OutlinePublishingAuthorization,
  type OutlineShadowPreview,
} from "../src/modules/outline/index.js";

const source: OutlineCompletionSource = {
  companyId: "00000000-0000-4000-8000-000000000001",
  issueId: "00000000-0000-4000-8000-000000000002",
  issueIdentifier: "STA-42",
  issueTitle: "Introduce a durable webhook ledger",
  issueUrl: "https://paperclip.example/STA/issues/STA-42?token=should-not-survive",
  completedAt: "2026-08-07T10:00:00.000Z",
};

const destination: OutlineDestinationConfig = {
  accessMode: "mcp",
  connectionId: "outline-sandbox",
  connectionRevision: "oauth-v1",
  tools: {
    documentsInfo: "list_documents",
    documentsCreate: "create_document",
    documentsUpdate: "update_document",
  },
  targets: {
    architecture: {
      collectionId: "89f93133-b508-4143-a281-d19488881eb9",
      parentDocumentId: "6806f4b9-36ed-442b-a91e-43ee75f4dcb1",
      parentTitle: "Architecture",
    },
    reports: {
      collectionId: "89f93133-b508-4143-a281-d19488881eb9",
      parentDocumentId: "43333bc2-f05b-47c7-bdd4-03fd43534c76",
      parentTitle: "Reports",
    },
    processes: {
      collectionId: "89f93133-b508-4143-a281-d19488881eb9",
      parentDocumentId: "0f5fcd02-9849-4b1d-a36c-1ed6efe2ac30",
      parentTitle: "Processes",
    },
  },
};

function assessment(policyVersion = "materiality-v1"): OutlineMaterialityAssessment {
  return {
    classification: "material",
    reasonCodes: ["architecture_changed"],
    targetClass: "Architecture",
    canonicalIdentity: {
      assessmentKey: `v1:paperclip:${source.issueIdentifier}:${policyVersion}`,
      documentKey: "v1:architecture:webhook-delivery",
      proposedAction: "create",
      existingDocumentRef: null,
    },
    evidence: [{
      kind: "issue",
      sourceRef: source.issueIdentifier,
      claim: "Introduced durable idempotency and redacted receipts for ops@example.com.",
    }],
    safeDraft: {
      template: "architecture_decision",
      title: "Webhook delivery architecture",
      bodyMarkdown: "# Webhook delivery architecture\n\nUse one canonical ledger. api_key=super-secret\n\nhttps://evidence.example/test?token=private",
    },
    review: { required: false, questions: [] },
  };
}

function preview(policyVersion = "materiality-v1"): OutlineShadowPreview {
  const result = renderOutlineShadowPreview({
    source,
    assessment: assessment(policyVersion),
    destination,
    policyVersion,
    generatedAt: new Date("2026-08-07T11:00:00.000Z"),
  });
  if (!result) throw new Error("expected material preview");
  return result;
}

function authorization(overrides: Partial<OutlinePublishingAuthorization> = {}): OutlinePublishingAuthorization {
  const fingerprint = outlineConfigurationFingerprint(destination);
  return {
    enabled: true,
    readOnly: false,
    externalWritesEnabled: true,
    exactConfigurationApproval: {
      status: "accepted",
      configurationRevisionId: "30000000-0000-4000-8000-000000000001",
      configurationFingerprint: fingerprint,
      interactionId: "40000000-0000-4000-8000-000000000001",
      acceptedAt: "2026-08-07T10:30:00.000Z",
    },
    writerProofs: [{
      accessMode: "mcp",
      connectionId: destination.connectionId,
      collectionId: destination.targets.architecture.collectionId,
      permission: "read_write",
      allowedParentDocumentIds: [destination.targets.architecture.parentDocumentId],
      configurationFingerprint: fingerprint,
      verifiedAt: "2026-08-07T10:40:00.000Z",
      expiresAt: "2026-08-08T10:40:00.000Z",
      tools: { ...destination.tools },
    }],
    ...overrides,
  };
}

class MemoryOutlineMcp implements OutlineMcpPort {
  documents = new Map<string, OutlineDocument>();
  calls: string[] = [];
  ambiguousCreate = false;
  commitAmbiguousCreate = false;

  async getDocument(id: string): Promise<OutlineDocument | null> {
    this.calls.push(`get:${id}`);
    return this.documents.get(id) ?? null;
  }

  async createDocument(input: {
    id: string;
    collectionId: string;
    parentDocumentId: string;
    title: string;
    text: string;
  }): Promise<OutlineDocument> {
    this.calls.push(`create:${input.id}`);
    const document: OutlineDocument = { ...input };
    if (!this.ambiguousCreate || this.commitAmbiguousCreate) this.documents.set(input.id, document);
    if (this.ambiguousCreate) throw new OutlineAmbiguousWriteError();
    return document;
  }

  async updateDocument(input: { id: string; title: string; text: string }): Promise<OutlineDocument> {
    this.calls.push(`update:${input.id}`);
    const existing = this.documents.get(input.id);
    if (!existing) throw new Error("missing document");
    const updated = { ...existing, ...input };
    this.documents.set(input.id, updated);
    return updated;
  }
}

describe("Outline shadow preview", () => {
  it("records no document preview for non-material work", () => {
    const result = renderOutlineShadowPreview({
      source,
      policyVersion: "materiality-v1",
      assessment: {
        classification: "not_material",
        reasonCodes: ["routine_completion"],
        targetClass: "none",
        canonicalIdentity: {
          assessmentKey: "v1:paperclip:STA-42:materiality-v1",
          documentKey: null,
          proposedAction: "none",
          existingDocumentRef: null,
        },
        evidence: [],
        safeDraft: null,
        review: { required: false, questions: [] },
      },
      destination,
    });
    expect(result).toBeNull();
  });

  it("rejects a materiality result whose assessment identity does not match source and policy", () => {
    const invalid = assessment();
    invalid.canonicalIdentity.assessmentKey = "v1:paperclip:STA-OTHER:materiality-v1";
    expect(() => renderOutlineShadowPreview({
      source,
      assessment: invalid,
      destination,
      policyVersion: "materiality-v1",
    })).toThrow("outline_materiality_assessment_key_mismatch");
  });

  it("renders a target/body preview with redaction and stable canonical identity", () => {
    const first = preview("materiality-v1");
    const nextPolicy = preview("materiality-v2");

    expect(first.parentTitle).toBe("Architecture");
    expect(first.mode).toBe("shadow");
    expect(first.wouldPublish).toBe(false);
    expect(first.body).toContain("[redacted-email]");
    expect(first.body).toContain("api_key=[redacted]");
    expect(first.body).not.toContain("token=private");
    expect(first.body).not.toContain("token=should-not-survive");
    expect(first.assessmentKey).not.toBe(nextPolicy.assessmentKey);
    expect(first.documentKey).toBe(nextPolicy.documentKey);
    expect(first.deterministicDocumentId).toBe(nextPolicy.deterministicDocumentId);
    expect(first.deterministicDocumentId).toBe(
      deterministicOutlineDocumentId(source.companyId, "v1:architecture:webhook-delivery"),
    );
  });
});

describe("Outline publishing gate", () => {
  it("rejects any non-MCP destination before provider access", () => {
    const nonMcpDestination = { ...destination, accessMode: "http" as "mcp" };
    expect(() => outlineConfigurationFingerprint(nonMcpDestination))
      .toThrow("outline_mcp_access_required");
  });

  it("binds writer proof to the exact MCP connection and tool set", async () => {
    const api = new MemoryOutlineMcp();
    const auth = authorization();
    auth.writerProofs = auth.writerProofs!.map((proof) => ({
      ...proof,
      connectionId: "another-outline-connection",
    }));
    await expect(publishOutlinePreview({
      preview: preview(),
      destination,
      authorization: auth,
      api,
      now: new Date("2026-08-07T11:00:00.000Z"),
    })).rejects.toEqual(expect.objectContaining({ code: "outline_writer_proof_mcp_connection_mismatch" }));
    expect(api.calls).toEqual([]);
  });

  it("fails closed when writer proof names a different MCP tool", async () => {
    const api = new MemoryOutlineMcp();
    const auth = authorization();
    auth.writerProofs = auth.writerProofs!.map((proof) => ({
      ...proof,
      tools: { ...proof.tools, documentsUpdate: "other_update_tool" },
    }));
    await expect(publishOutlinePreview({
      preview: preview(),
      destination,
      authorization: auth,
      api,
      now: new Date("2026-08-07T11:00:00.000Z"),
    })).rejects.toEqual(expect.objectContaining({ code: "outline_writer_mcp_tool_scope_incomplete" }));
    expect(api.calls).toEqual([]);
  });

  it("makes a write impossible while read-only mode is active", async () => {
    const api = new MemoryOutlineMcp();
    await expect(publishOutlinePreview({
      preview: preview(),
      destination,
      authorization: authorization({ readOnly: true }),
      api,
      now: new Date("2026-08-07T11:00:00.000Z"),
    })).rejects.toEqual(expect.objectContaining({ code: "outline_external_writes_disabled" }));
    expect(api.calls).toEqual([]);
  });

  it("fails before provider access when approval does not match exact config", async () => {
    const api = new MemoryOutlineMcp();
    const auth = authorization();
    auth.exactConfigurationApproval = {
      ...auth.exactConfigurationApproval!,
      configurationFingerprint: "sha256:stale",
    };
    await expect(publishOutlinePreview({
      preview: preview(),
      destination,
      authorization: auth,
      api,
      now: new Date("2026-08-07T11:00:00.000Z"),
    })).rejects.toEqual(expect.objectContaining({ code: "outline_configuration_changed_after_approval" }));
    expect(api.calls).toEqual([]);
  });

  it("fails closed before provider access when the writer proof is not current", async () => {
    const api = new MemoryOutlineMcp();
    const auth = authorization();
    auth.writerProofs = auth.writerProofs!.map((proof) => ({
      ...proof,
      verifiedAt: "not-a-timestamp",
    }));
    await expect(publishOutlinePreview({
      preview: preview(),
      destination,
      authorization: auth,
      api,
      now: new Date("2026-08-07T11:00:00.000Z"),
    })).rejects.toEqual(expect.objectContaining({ code: "outline_writer_proof_expired" }));
    expect(api.calls).toEqual([]);
  });
});

describe("Outline idempotent upsert", () => {
  it("creates once, then treats a rerun as already current", async () => {
    const api = new MemoryOutlineMcp();
    const now = new Date("2026-08-07T11:00:00.000Z");
    const first = await publishOutlinePreview({ preview: preview(), destination, authorization: authorization(), api, now });
    const second = await publishOutlinePreview({ preview: preview(), destination, authorization: authorization(), api, now });

    expect(first.action).toBe("created");
    expect(second.action).toBe("already_current");
    expect(api.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(api.documents).toHaveLength(1);
  });

  it("updates the same canonical document after a policy reassessment", async () => {
    const api = new MemoryOutlineMcp();
    const firstPreview = preview("materiality-v1");
    await publishOutlinePreview({
      preview: firstPreview, destination, authorization: authorization(), api,
      now: new Date("2026-08-07T11:00:00.000Z"),
    });
    const reassessment = assessment("materiality-v2");
    reassessment.safeDraft = {
      ...reassessment.safeDraft!,
      bodyMarkdown: "# Webhook delivery architecture\n\nUpdated architecture outcome.",
    };
    const changedPreview = renderOutlineShadowPreview({
      source,
      assessment: reassessment,
      destination,
      policyVersion: "materiality-v2",
      generatedAt: new Date("2026-08-07T12:00:00.000Z"),
    })!;
    const result = await publishOutlinePreview({
      preview: changedPreview, destination, authorization: authorization(), api,
      now: new Date("2026-08-07T12:00:00.000Z"),
    });

    expect(result.action).toBe("updated");
    expect(changedPreview.deterministicDocumentId).toBe(firstPreview.deterministicDocumentId);
    expect(api.documents).toHaveLength(1);
  });

  it("reconciles an ambiguous create before deciding whether to retry", async () => {
    const api = new MemoryOutlineMcp();
    api.ambiguousCreate = true;
    api.commitAmbiguousCreate = true;
    const result = await publishOutlinePreview({
      preview: preview(), destination, authorization: authorization(), api,
      now: new Date("2026-08-07T11:00:00.000Z"),
    });

    expect(result.outcome).toBe("succeeded");
    expect(result.action).toBe("already_current");
    expect(result.reconciledBeforeRetry).toBe(true);
    expect(api.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(api.calls.at(-1)).toMatch(/^get:/);
  });

  it("returns one exception identity without touching source completion", async () => {
    const api = new MemoryOutlineMcp();
    api.ambiguousCreate = true;
    const first = await publishOutlinePreview({
      preview: preview(), destination, authorization: authorization(), api,
      now: new Date("2026-08-07T11:00:00.000Z"),
    });
    const second = await publishOutlinePreview({
      preview: preview(), destination, authorization: authorization(), api,
      now: new Date("2026-08-07T11:05:00.000Z"),
    });

    expect(first.outcome).toBe("retryable_failure");
    expect(first.reconciledBeforeRetry).toBe(true);
    expect(first.exceptionKey).toBe(second.exceptionKey);
    expect(first.sourceIssueMutation).toBe("none");
    expect(first).not.toHaveProperty("body");
    expect(first).not.toHaveProperty("title");
  });
});

class MemoryAssessmentRepository implements OutlineAssessmentRepository {
  record: OutlineAssessmentRecord | null = null;
  leaseToken: string | null = null;
  async acquire(input: Parameters<OutlineAssessmentRepository["acquire"]>[0]) {
    if (!this.record) this.record = { id: "assessment-1", companyId: input.companyId, projectId: input.projectId, sourceIssueId: input.sourceIssueId, policyVersion: input.policyVersion, assessmentKey: input.assessmentKey, status: "pending", assessment: null, preview: null, attempt: 0, observationCount: 0, requestedAt: "2026-08-07T10:00:00.000Z", assessedAt: null };
    this.record.observationCount += 1;
    if (this.record.status !== "pending" || this.leaseToken) return { record: { ...this.record }, acquired: false };
    this.leaseToken = input.leaseToken;
    this.record.attempt += 1;
    return { record: { ...this.record }, acquired: true };
  }
  async complete(input: Parameters<OutlineAssessmentRepository["complete"]>[0]) {
    if (!this.record || this.leaseToken !== input.leaseToken) return false;
    Object.assign(this.record, { status: input.status, assessment: input.assessment, preview: input.preview, assessedAt: "2026-08-07T11:00:00.000Z" });
    this.leaseToken = null;
    return true;
  }
  async release(input: Parameters<OutlineAssessmentRepository["release"]>[0]) {
    if (!this.record || this.leaseToken !== input.leaseToken) return false;
    this.leaseToken = null;
    return true;
  }
  async get(companyId: string, sourceIssueId: string, policyVersion: string) {
    if (!this.record || this.record.companyId !== companyId || this.record.sourceIssueId !== sourceIssueId || this.record.policyVersion !== policyVersion) return null;
    return { ...this.record };
  }
  async getOldestUnassessedAgeMs() { return this.record?.status === "pending" ? 3_600_000 : null; }
}

describe("Outline assessment coordination", () => {
  const audit = { actorType: "system" as const, actorId: null, runId: "run-1" };

  it("assesses event and reconciliation observations once per policy", async () => {
    const repository = new MemoryAssessmentRepository();
    let calls = 0;
    const coordinator = new OutlineAssessmentCoordinator(repository, { async assess() { calls += 1; return assessment(); } }, () => new Date("2026-08-07T11:00:00.000Z"));
    const first = await coordinator.assessCompletion({ projectId: "project-1", source, destination, policyVersion: "materiality-v1", trigger: "event", audit });
    const replay = await coordinator.assessCompletion({ projectId: "project-1", source, destination, policyVersion: "materiality-v1", trigger: "schedule", audit });
    expect(calls).toBe(1);
    expect(first).toMatchObject({ outcome: "assessed", record: { status: "material" } });
    expect(first.record.preview).toMatchObject({ mode: "shadow", wouldPublish: false });
    expect(JSON.stringify(first.record.assessment)).not.toContain("ops@example.com");
    expect(JSON.stringify(first.record.assessment)).not.toContain("super-secret");
    expect(replay).toMatchObject({ outcome: "already_assessed" });
    expect(replay.record.observationCount).toBe(2);
  });

  it("coalesces overlapping assessment attempts before invoking the skill twice", async () => {
    const repository = new MemoryAssessmentRepository();
    let resolveAssessment!: (value: OutlineMaterialityAssessment) => void;
    let calls = 0;
    const coordinator = new OutlineAssessmentCoordinator(repository, { assess: () => { calls += 1; return new Promise((resolve) => { resolveAssessment = resolve; }); } });
    const first = coordinator.assessCompletion({ projectId: "project-1", source, destination, policyVersion: "materiality-v1", trigger: "event", audit });
    await Promise.resolve();
    const overlapping = await coordinator.assessCompletion({ projectId: "project-1", source, destination, policyVersion: "materiality-v1", trigger: "schedule", audit });
    resolveAssessment(assessment());
    await first;
    expect(calls).toBe(1);
    expect(overlapping.outcome).toBe("coalesced");
  });

  it("persists non-material assessments without a document preview", async () => {
    const repository = new MemoryAssessmentRepository();
    const notMaterial = assessment();
    notMaterial.classification = "not_material";
    notMaterial.reasonCodes = ["routine_completion"];
    notMaterial.targetClass = "none";
    notMaterial.canonicalIdentity = { assessmentKey: "v1:paperclip:STA-42:materiality-v1", documentKey: null, proposedAction: "none", existingDocumentRef: null };
    notMaterial.safeDraft = null;
    const coordinator = new OutlineAssessmentCoordinator(repository, { assess: async () => notMaterial });
    const result = await coordinator.assessCompletion({ projectId: "project-1", source, destination, policyVersion: "materiality-v1", trigger: "event", audit });
    expect(result).toMatchObject({ outcome: "assessed", record: { status: "not_material", preview: null } });
  });
});
