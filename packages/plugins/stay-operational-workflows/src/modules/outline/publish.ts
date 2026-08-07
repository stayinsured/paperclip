import { assertOutlinePublishingAuthorized } from "./authorization.js";
import { OutlineAmbiguousWriteError, OutlineApiError } from "./api.js";
import { outlineExceptionKey, outlineOperationKey, sha256 } from "./identity.js";
import type {
  OutlineApiPort,
  OutlineDestinationConfig,
  OutlineDocument,
  OutlinePublishingAuthorization,
  OutlinePublishReceipt,
  OutlineShadowPreview,
} from "./types.js";

function matchesPreview(document: OutlineDocument, preview: OutlineShadowPreview): boolean {
  return (
    document.id === preview.deterministicDocumentId &&
    document.collectionId === preview.collectionId &&
    document.parentDocumentId === preview.parentDocumentId &&
    document.title === preview.title &&
    sha256(document.text) === preview.bodySha256
  );
}

function receipt(
  preview: OutlineShadowPreview,
  input: Omit<OutlinePublishReceipt, "schemaVersion" | "operationKey" | "exceptionKey" | "companyId" | "sourceIssueId" | "policyVersion" | "target" | "documentId" | "collectionId" | "parentDocumentId" | "bodySha256" | "sourceIssueMutation" | "occurredAt"> & {
    occurredAt?: Date;
  },
): OutlinePublishReceipt {
  const { occurredAt, ...fields } = input;
  return {
    schemaVersion: 1,
    operationKey: outlineOperationKey(preview.companyId, preview.sourceIssueId, preview.policyVersion),
    exceptionKey: outlineExceptionKey(preview.companyId, preview.sourceIssueId),
    companyId: preview.companyId,
    sourceIssueId: preview.sourceIssueId,
    policyVersion: preview.policyVersion,
    target: preview.target,
    documentId: preview.deterministicDocumentId,
    collectionId: preview.collectionId,
    parentDocumentId: preview.parentDocumentId,
    bodySha256: preview.bodySha256,
    sourceIssueMutation: "none",
    occurredAt: (occurredAt ?? new Date()).toISOString(),
    ...fields,
  };
}

function assertExistingDocumentDestination(document: OutlineDocument, preview: OutlineShadowPreview): void {
  if (
    document.collectionId !== preview.collectionId ||
    document.parentDocumentId !== preview.parentDocumentId
  ) {
    throw new OutlineApiError("outline_deterministic_document_destination_conflict", false);
  }
}

async function reconcileAfterAmbiguousWrite(
  api: OutlineApiPort,
  preview: OutlineShadowPreview,
  error: OutlineAmbiguousWriteError,
): Promise<OutlinePublishReceipt> {
  let reconciled: OutlineDocument | null = null;
  try {
    reconciled = await api.getDocument(preview.deterministicDocumentId);
  } catch (readError) {
    const typed = readError instanceof OutlineApiError ? readError : new OutlineApiError("outline_reconciliation_failed", true);
    return receipt(preview, {
      action: "failed",
      outcome: typed.retryable ? "retryable_failure" : "terminal_failure",
      errorClass: typed.code,
      retryAfterMs: typed.retryAfterMs ?? error.retryAfterMs,
      reconciledBeforeRetry: true,
    });
  }

  if (reconciled && matchesPreview(reconciled, preview)) {
    return receipt(preview, {
      action: "already_current",
      outcome: "succeeded",
      errorClass: null,
      retryAfterMs: null,
      reconciledBeforeRetry: true,
    });
  }
  if (reconciled) {
    try {
      assertExistingDocumentDestination(reconciled, preview);
    } catch (destinationError) {
      const typed = destinationError instanceof OutlineApiError
        ? destinationError
        : new OutlineApiError("outline_reconciliation_destination_conflict", false);
      return receipt(preview, {
        action: "failed",
        outcome: "terminal_failure",
        errorClass: typed.code,
        retryAfterMs: null,
        reconciledBeforeRetry: true,
      });
    }
  }
  return receipt(preview, {
    action: "failed",
    outcome: "retryable_failure",
    errorClass: error.code,
    retryAfterMs: error.retryAfterMs,
    reconciledBeforeRetry: true,
  });
}

export async function publishOutlinePreview(input: {
  preview: OutlineShadowPreview;
  destination: OutlineDestinationConfig;
  authorization: OutlinePublishingAuthorization;
  api: OutlineApiPort;
  now?: Date;
}): Promise<OutlinePublishReceipt> {
  const { preview, destination, authorization, api } = input;
  assertOutlinePublishingAuthorized({ preview, destination, authorization, now: input.now });

  try {
    const existing = await api.getDocument(preview.deterministicDocumentId);
    if (existing) {
      assertExistingDocumentDestination(existing, preview);
      if (matchesPreview(existing, preview)) {
        return receipt(preview, {
          action: "already_current",
          outcome: "succeeded",
          errorClass: null,
          retryAfterMs: null,
          reconciledBeforeRetry: false,
          occurredAt: input.now,
        });
      }
      await api.updateDocument({
        id: preview.deterministicDocumentId,
        title: preview.title,
        text: preview.body,
      });
      const verified = await api.getDocument(preview.deterministicDocumentId);
      if (!verified || !matchesPreview(verified, preview)) {
        throw new OutlineAmbiguousWriteError("outline_update_verification_mismatch");
      }
      return receipt(preview, {
        action: "updated",
        outcome: "succeeded",
        errorClass: null,
        retryAfterMs: null,
        reconciledBeforeRetry: false,
        occurredAt: input.now,
      });
    }

    await api.createDocument({
      id: preview.deterministicDocumentId,
      collectionId: preview.collectionId,
      parentDocumentId: preview.parentDocumentId,
      title: preview.title,
      text: preview.body,
    });
    const verified = await api.getDocument(preview.deterministicDocumentId);
    if (!verified || !matchesPreview(verified, preview)) {
      throw new OutlineAmbiguousWriteError("outline_create_verification_mismatch");
    }
    return receipt(preview, {
      action: "created",
      outcome: "succeeded",
      errorClass: null,
      retryAfterMs: null,
      reconciledBeforeRetry: false,
      occurredAt: input.now,
    });
  } catch (error) {
    if (error instanceof OutlineAmbiguousWriteError) {
      return reconcileAfterAmbiguousWrite(api, preview, error);
    }
    const typed = error instanceof OutlineApiError ? error : new OutlineApiError("outline_publish_failed", false);
    return receipt(preview, {
      action: "failed",
      outcome: typed.retryable ? "retryable_failure" : "terminal_failure",
      errorClass: typed.code,
      retryAfterMs: typed.retryAfterMs,
      reconciledBeforeRetry: false,
      occurredAt: input.now,
    });
  }
}
