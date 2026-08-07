import {
  deterministicOutlineDocumentId,
  outlineDocumentKey,
  sha256,
} from "./identity.js";
import { assertOutlineMaterialityAssessment, outlineTargetFromClass } from "./materiality.js";
import type {
  OutlineCompletionSource,
  OutlineDestinationConfig,
  OutlineMaterialityAssessment,
  OutlineShadowPreview,
} from "./types.js";

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const OUTLINE_TOKEN_PATTERN = /\bol_api_[A-Za-z0-9]{20,}\b/g;
const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi;
const URL_PATTERN = /https?:\/\/[^\s<>)\]]+/gi;

export function redactOutlineText(value: string): string {
  const redacted = value
    .replace(OUTLINE_TOKEN_PATTERN, "[redacted-outline-token]")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1=[redacted]")
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(/\u0000/g, "");
  return redacted.replace(URL_PATTERN, (candidate) => {
    try {
      return safeUrl(candidate);
    } catch {
      return "[redacted-url]";
    }
  }).trim();
}

function safeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("outline_preview_url_scheme_not_allowed");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function renderBody(
  source: OutlineCompletionSource,
  assessment: OutlineMaterialityAssessment & { safeDraft: NonNullable<OutlineMaterialityAssessment["safeDraft"]> },
  policyVersion: string,
  deterministicDocumentId: string,
): string {
  const sourceUrl = safeUrl(source.issueUrl);
  const marker = `<!-- stay-operational-workflows:outline:v1 source=${source.issueId} document=${deterministicDocumentId} -->`;
  const lines = [
    marker,
    redactOutlineText(assessment.safeDraft.bodyMarkdown),
    "",
    "---",
    "",
    `Source: [${redactOutlineText(source.issueIdentifier)}](${sourceUrl})  `,
    `Completed: ${new Date(source.completedAt).toISOString()}  `,
    `Materiality policy: ${redactOutlineText(policyVersion)}`,
  ];

  if (assessment.evidence.length > 0) {
    lines.push("", "## Evidence", "");
    for (const evidence of assessment.evidence) {
      lines.push(
        `- ${redactOutlineText(evidence.kind)} \`${redactOutlineText(evidence.sourceRef)}\`: ${redactOutlineText(evidence.claim)}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderOutlineShadowPreview(input: {
  source: OutlineCompletionSource;
  assessment: OutlineMaterialityAssessment;
  destination: OutlineDestinationConfig;
  policyVersion: string;
  generatedAt?: Date;
}): OutlineShadowPreview | null {
  const { source, assessment, destination } = input;
  assertOutlineMaterialityAssessment({
    source,
    policyVersion: input.policyVersion,
    assessment,
  });
  if (assessment.classification !== "material") {
    return null;
  }

  const targetClass = assessment.targetClass as Exclude<typeof assessment.targetClass, "none">;
  const targetKey = outlineTargetFromClass(targetClass);
  const target = destination.targets[targetKey];
  if (!target) {
    throw new Error("outline_target_not_configured");
  }
  const canonicalDocumentKey = assessment.canonicalIdentity.documentKey!;
  const deterministicDocumentId = deterministicOutlineDocumentId(source.companyId, canonicalDocumentKey);
  const title = redactOutlineText(assessment.safeDraft!.title);
  if (!title) {
    throw new Error("outline_preview_title_empty");
  }
  const body = renderBody(
    source,
    assessment as OutlineMaterialityAssessment & { safeDraft: NonNullable<OutlineMaterialityAssessment["safeDraft"]> },
    input.policyVersion,
    deterministicDocumentId,
  );

  return {
    schemaVersion: 1,
    assessmentKey: assessment.canonicalIdentity.assessmentKey,
    documentKey: outlineDocumentKey(source.companyId, canonicalDocumentKey),
    deterministicDocumentId,
    companyId: source.companyId,
    sourceIssueId: source.issueId,
    sourceIssueIdentifier: source.issueIdentifier,
    policyVersion: input.policyVersion,
    target: targetKey,
    collectionId: target.collectionId,
    parentDocumentId: target.parentDocumentId,
    parentTitle: target.parentTitle,
    title,
    body,
    bodySha256: sha256(body),
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    mode: "shadow",
    wouldPublish: false,
  };
}
