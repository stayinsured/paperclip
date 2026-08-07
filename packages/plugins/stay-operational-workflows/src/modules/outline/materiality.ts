import type {
  OutlineCompletionSource,
  OutlineMaterialityAssessment,
  OutlineTarget,
  OutlineTargetClass,
} from "./types.js";

const MATERIAL_CODES = new Set([
  "architecture_created",
  "architecture_changed",
  "durable_decision",
  "significant_delivery_outcome",
  "durable_outcome_metrics",
  "operator_procedure_created",
  "operator_procedure_changed",
]);
const NOT_MATERIAL_CODES = new Set([
  "routine_completion",
  "trivial_change",
  "non_durable_result",
  "insufficient_outcome",
  "duplicate_candidate",
  "already_documented_no_change",
  "evidence_not_durable",
]);
const REVIEW_CODES = new Set([
  "ambiguous_materiality",
  "conflicting_evidence",
  "canonical_identity_unclear",
  "destination_unclear",
  "multiple_primary_targets",
  "unsafe_source_content",
  "insufficient_safe_evidence",
]);

const TARGETS: Record<Exclude<OutlineTargetClass, "none">, OutlineTarget> = {
  Architecture: "architecture",
  Reports: "reports",
  Processes: "processes",
};
const TEMPLATES = {
  Architecture: "architecture_decision",
  Reports: "completed_task_outcome",
  Processes: "operator_process",
} as const;

export function materialityAssessmentKey(
  source: Pick<OutlineCompletionSource, "issueIdentifier">,
  policyVersion: string,
): string {
  return `v1:paperclip:${source.issueIdentifier}:${policyVersion}`;
}

export function outlineTargetFromClass(targetClass: Exclude<OutlineTargetClass, "none">): OutlineTarget {
  return TARGETS[targetClass];
}

export function assertOutlineMaterialityAssessment(input: {
  source: OutlineCompletionSource;
  policyVersion: string;
  assessment: OutlineMaterialityAssessment;
}): void {
  const { source, policyVersion, assessment } = input;
  if (assessment.canonicalIdentity.assessmentKey !== materialityAssessmentKey(source, policyVersion)) {
    throw new Error("outline_materiality_assessment_key_mismatch");
  }
  if (
    assessment.reasonCodes.length === 0 ||
    new Set(assessment.reasonCodes).size !== assessment.reasonCodes.length
  ) {
    throw new Error("outline_materiality_reason_codes_invalid");
  }

  const allowedCodes = assessment.classification === "material"
    ? MATERIAL_CODES
    : assessment.classification === "not_material" ? NOT_MATERIAL_CODES : REVIEW_CODES;
  if (assessment.reasonCodes.some((code) => !allowedCodes.has(code))) {
    throw new Error("outline_materiality_reason_code_not_allowed");
  }

  if (assessment.classification === "material") {
    if (
      assessment.targetClass === "none" ||
      assessment.canonicalIdentity.documentKey == null ||
      assessment.canonicalIdentity.proposedAction === "none" ||
      assessment.safeDraft == null ||
      assessment.review.required ||
      assessment.review.questions.length !== 0
    ) {
      throw new Error("outline_materiality_material_invariant_failed");
    }
    const target = outlineTargetFromClass(assessment.targetClass);
    if (!assessment.canonicalIdentity.documentKey.startsWith(`v1:${target}:`)) {
      throw new Error("outline_materiality_document_key_target_mismatch");
    }
    if (!/^v1:(architecture|reports|processes):[a-z0-9]+(?:-[a-z0-9]+)*$/.test(assessment.canonicalIdentity.documentKey)) {
      throw new Error("outline_materiality_document_key_invalid");
    }
    if (assessment.safeDraft.template !== TEMPLATES[assessment.targetClass]) {
      throw new Error("outline_materiality_template_target_mismatch");
    }
    return;
  }

  if (
    assessment.targetClass !== "none" ||
    assessment.canonicalIdentity.proposedAction !== "none" ||
    assessment.safeDraft !== null
  ) {
    throw new Error("outline_materiality_non_publishable_invariant_failed");
  }
  if (assessment.classification === "needs_review") {
    if (
      assessment.canonicalIdentity.documentKey !== null ||
      assessment.canonicalIdentity.existingDocumentRef !== null ||
      !assessment.review.required ||
      assessment.review.questions.length < 1 ||
      assessment.review.questions.length > 3
    ) {
      throw new Error("outline_materiality_review_invariant_failed");
    }
  } else if (assessment.review.required || assessment.review.questions.length !== 0) {
    throw new Error("outline_materiality_negative_review_invariant_failed");
  }
}
