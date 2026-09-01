import { z } from "zod";

/**
 * Structured terminal-comment finalizer (rollout improvement R9).
 *
 * Terminal issue comments summarize the outcome of an adapter run. Left
 * unconstrained, raw progress transcripts — wake digests, continuation-summary
 * scaffolding, run narration — leak into the durable thread. The finalizer
 * gives adapter runs a structured submission contract (status, evidence,
 * limitation, next owner, disposition) and strips the known
 * progress-transcript headings before the comment is durably written. Raw
 * execution detail is never carried into comments; it stays in run logs.
 */

/**
 * Markdown section headings that only occur in generated progress
 * scaffolding (continuation summaries and run digests). A comment that
 * replays them is a leaked transcript, not a hand-authored summary, so the
 * finalizer removes those sections wholesale. Ordinary markdown never uses
 * these exact headings, which keeps false positives near zero.
 */
export const PROGRESS_TRANSCRIPT_SECTION_HEADINGS = [
  "Continuation Summary",
  "Recent Concrete Actions",
  "Commands Run",
  "Files / Routes Touched",
  "Blockers / Decisions",
  "Next Action",
] as const;

const PROGRESS_TRANSCRIPT_HEADING_KEYS = new Set(
  PROGRESS_TRANSCRIPT_SECTION_HEADINGS.map((heading) => heading.toLowerCase()),
);

const MARKDOWN_HEADING_PATTERN = /^(#{1,6})[ \t]+(\S.*?)[ \t]*$/;

export type ProgressTranscriptSanitization = {
  text: string;
  removedHeadings: string[];
};

/**
 * Removes sections whose heading matches a known progress-transcript
 * heading. Text without those headings is returned byte-identical.
 */
export function sanitizeProgressTranscriptMarkdown(markdown: string): ProgressTranscriptSanitization {
  if (!markdown) return { text: markdown, removedHeadings: [] };
  const lines = markdown.split("\n");
  const kept: string[] = [];
  const removedHeadings: string[] = [];
  // While set, every line belongs to a removed section and is dropped until a
  // heading at the same or shallower level ends that section.
  let skippingLevel: number | null = null;
  for (const line of lines) {
    const match = MARKDOWN_HEADING_PATTERN.exec(line);
    const level = match ? match[1].length : null;
    if (skippingLevel !== null) {
      if (level !== null && level <= skippingLevel) {
        skippingLevel = null;
      } else {
        continue;
      }
    }
    const headingKey = match ? match[2].toLowerCase().replace(/[.:]+$/, "") : null;
    if (headingKey !== null && PROGRESS_TRANSCRIPT_HEADING_KEYS.has(headingKey)) {
      removedHeadings.push(match![2]);
      skippingLevel = level;
      continue;
    }
    kept.push(line);
  }
  if (removedHeadings.length === 0) return { text: markdown, removedHeadings: [] };
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removedHeadings };
}

/**
 * Structured terminal-comment fields submitted by adapter runs. Every field
 * is bounded and flattened to a single line when rendered, so a draft can
 * never smuggle a heading or a multi-line transcript block into a comment.
 */
export const terminalCommentDraftSchema = z
  .object({
    status: z.string().trim().min(1).max(200),
    evidence: z.array(z.string().trim().min(1).max(500)).min(0).max(12).optional(),
    limitation: z.string().trim().min(1).max(500).nullable().optional(),
    nextOwner: z.string().trim().min(1).max(160).nullable().optional(),
    disposition: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .strict();

export type TerminalCommentDraft = z.infer<typeof terminalCommentDraftSchema>;

function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Renders the durable comment body from structured fields only. */
export function renderTerminalCommentBody(draft: TerminalCommentDraft): string {
  const lines: string[] = [`**Status:** ${inline(draft.status)}`];
  const evidence = (draft.evidence ?? []).map(inline).filter((item) => item.length > 0);
  if (evidence.length > 0) {
    lines.push("", "**Evidence:**", ...evidence.map((item) => `- ${item}`));
  }
  if (draft.limitation) lines.push("", `**Limitation:** ${inline(draft.limitation)}`);
  if (draft.nextOwner) lines.push("", `**Next owner:** ${inline(draft.nextOwner)}`);
  if (draft.disposition) lines.push("", `**Disposition:** ${inline(draft.disposition)}`);
  return lines.join("\n");
}

export type TerminalCommentFinalization =
  | { ok: true; body: string; structured: boolean; removedHeadings: string[] }
  | { ok: false; error: string };

/**
 * Computes the durable body for a comment write.
 *
 * - A structured draft renders deterministically; any free-text body is
 *   appended only after progress-transcript sections are stripped from it.
 * - Run-scoped comments (adapter submissions) always get sanitized; if
 *   sanitizing leaves nothing but stripped transcript scaffolding, the write
 *   is rejected so the agent resubmits a real terminal summary.
 * - Comments outside a run (humans, board) are left untouched.
 */
export function finalizeTerminalComment(input: {
  runScoped: boolean;
  body: string;
  terminal?: TerminalCommentDraft | null;
}): TerminalCommentFinalization {
  const terminal = input.terminal ?? null;
  if (terminal) {
    const structuredBody = renderTerminalCommentBody(terminal);
    const sanitization = sanitizeProgressTranscriptMarkdown(input.body);
    const remainingBody = sanitization.text.trim();
    const body = remainingBody.length > 0 ? `${structuredBody}\n\n${remainingBody}` : structuredBody;
    return { ok: true, body, structured: true, removedHeadings: sanitization.removedHeadings };
  }
  if (!input.runScoped) return { ok: true, body: input.body, structured: false, removedHeadings: [] };
  const sanitization = sanitizeProgressTranscriptMarkdown(input.body);
  if (sanitization.removedHeadings.length > 0 && sanitization.text.trim().length === 0) {
    return {
      ok: false,
      error:
        "Comment contained only progress-transcript scaffolding; submit a terminal summary instead "
        + "(structured terminal fields: status, evidence, limitation, nextOwner, disposition). "
        + "Raw execution detail belongs in run logs.",
    };
  }
  return { ok: true, body: sanitization.text, structured: false, removedHeadings: sanitization.removedHeadings };
}
