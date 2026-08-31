import { z } from "zod";

export const REFLECTION_TARGET_STATES = [
  "proposed",
  "pending",
  "accepted",
  "applied",
  "independently_validated",
  "rejected",
  "evidence_backed_no_change",
] as const;

export type ReflectionTargetState = (typeof REFLECTION_TARGET_STATES)[number];

export const REFLECTION_TARGET_TYPES = [
  "agent_instructions",
  "agent_profile",
  "company_skill",
  "company_skill_import",
  "skills_scan",
  "other",
] as const;

export type ReflectionTargetType = (typeof REFLECTION_TARGET_TYPES)[number];

export const reflectionProposalTargetSchema = z.object({
  targetKey: z.string().trim().min(1).max(120),
  targetType: z.enum(REFLECTION_TARGET_TYPES),
  targetLabel: z.string().trim().min(1).max(200),
  proposalRevision: z.string().trim().min(1).max(255),
  proposedDiff: z.string().max(50_000).nullable().optional(),
  evidenceMarkdown: z.string().trim().min(1).max(50_000).nullable().optional(),
  state: z.enum(["proposed", "evidence_backed_no_change"]).optional().default("proposed"),
}).superRefine((value, ctx) => {
  if (value.state === "proposed" && !value.proposedDiff?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "proposed targets require proposedDiff",
      path: ["proposedDiff"],
    });
  }
  if (value.state === "evidence_backed_no_change" && !value.evidenceMarkdown?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "evidence_backed_no_change targets require evidenceMarkdown",
      path: ["evidenceMarkdown"],
    });
  }
});

export const registerReflectionProposalSchema = z.object({
  version: z.literal(1),
  proposalKey: z.string().trim().min(1).max(200),
  targets: z.array(reflectionProposalTargetSchema).min(1).max(50),
}).superRefine((value, ctx) => {
  const keys = new Set<string>();
  for (const [index, target] of value.targets.entries()) {
    const identity = `${target.targetKey}\u0000${target.proposalRevision}`;
    if (keys.has(identity)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "targetKey and proposalRevision must be unique within a proposal",
        path: ["targets", index, "targetKey"],
      });
    }
    keys.add(identity);
  }
});

export const validateReflectionTargetSchema = z.object({
  version: z.literal(1),
  evidenceMarkdown: z.string().trim().min(1).max(50_000),
});

export type RegisterReflectionProposal = z.infer<typeof registerReflectionProposalSchema>;
export type ReflectionProposalTargetInput = z.infer<typeof reflectionProposalTargetSchema>;
export type ValidateReflectionTarget = z.infer<typeof validateReflectionTargetSchema>;

export interface ReflectionLedgerTarget {
  id: string;
  companyId: string;
  issueId: string;
  proposalAgentId: string;
  sourceRunId: string;
  proposalKey: string;
  targetKey: string;
  targetType: ReflectionTargetType;
  targetLabel: string;
  proposalRevision: string;
  proposedDiff: string | null;
  evidenceMarkdown: string | null;
  state: ReflectionTargetState;
  confirmationInteractionId: string | null;
  applicationIssueId: string | null;
  acceptedAt: Date | string | null;
  appliedAt: Date | string | null;
  validatedAt: Date | string | null;
  validatedByAgentId: string | null;
  validatedByRunId: string | null;
  validatedByUserId: string | null;
  rejectedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface InstructionMutationReceipt {
  id: string;
  companyId: string;
  issueId: string;
  ledgerTargetId: string;
  targetKey: string;
  targetType: ReflectionTargetType;
  targetLabel: string;
  targetAgentId: string;
  acceptedInteractionId: string;
  applicationIssueId: string;
  actorAgentId: string;
  actorRunId: string;
  instructionPath: string;
  beforeContent: string;
  appliedDiff: string;
  postWriteContent: string;
  createdAt: Date | string;
}

export interface IssueReflectionEvidence {
  targets: ReflectionLedgerTarget[];
  receipts: InstructionMutationReceipt[];
}
