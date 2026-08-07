import { describe, expect, it } from "vitest";
import {
  OutlineAmbiguousWriteError,
  deterministicOutlineDocumentId,
  outlineConfigurationFingerprint,
  publishOutlinePreview,
  renderOutlineShadowPreview,
  type OutlineApiPort,
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
  apiBaseUrl: "https://docs.example/api",
  tokenSecretId: "00000000-0000-4000-8000-000000000003",
  tokenSecretVersion: 1,
  targets: {
    architecture: {
      collectionId: "10000000-0000-4000-8000-000000000001",
      parentDocumentId: "20000000-0000-4000-8000-000000000001",
      parentTitle: "Architecture",
    },
    reports: {
      collectionId: "10000000-0000-4000-8000-000000000001",
      parentDocumentId: "20000000-0000-4000-8000-000000000002",
      parentTitle: "Reports",
    },
    processes: {
      collectionId: "10000000-0000-4000-8000-000000000001",
      parentDocumentId: "20000000-0000-4000-8000-000000000003",
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
      collectionId: destination.targets.architecture.collectionId,
      permission: "read_write",
      allowedParentDocumentIds: [destination.targets.architecture.parentDocumentId],
      configurationFingerprint: fingerprint,
      verifiedAt: "2026-08-07T10:40:00.000Z",
      expiresAt: "2026-08-08T10:40:00.000Z",
      endpoints: { documentsInfo: true, documentsCreate: true, documentsUpdate: true },
    }],
    ...overrides,
  };
}

class MemoryOutlineApi implements OutlineApiPort {
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
  it("makes a write impossible while read-only mode is active", async () => {
    const api = new MemoryOutlineApi();
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
    const api = new MemoryOutlineApi();
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
    const api = new MemoryOutlineApi();
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
    const api = new MemoryOutlineApi();
    const now = new Date("2026-08-07T11:00:00.000Z");
    const first = await publishOutlinePreview({ preview: preview(), destination, authorization: authorization(), api, now });
    const second = await publishOutlinePreview({ preview: preview(), destination, authorization: authorization(), api, now });

    expect(first.action).toBe("created");
    expect(second.action).toBe("already_current");
    expect(api.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(api.documents).toHaveLength(1);
  });

  it("updates the same canonical document after a policy reassessment", async () => {
    const api = new MemoryOutlineApi();
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
    const api = new MemoryOutlineApi();
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
    const api = new MemoryOutlineApi();
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

