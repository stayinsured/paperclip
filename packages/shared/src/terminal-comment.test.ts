import { describe, expect, it } from "vitest";
import {
  PROGRESS_TRANSCRIPT_SECTION_HEADINGS,
  finalizeTerminalComment,
  renderTerminalCommentBody,
  sanitizeProgressTranscriptMarkdown,
} from "./terminal-comment.js";

// Replay case 1: a full continuation-summary scaffold leaked verbatim into a
// comment (shape captured from a real run digest on STA-2904).
const FULL_SCAFFOLD_REPLAY = [
  "# Continuation Summary",
  "",
  "- Issue: STA-2904 — SDLC improvement R9 - Structured terminal-comment finalizer",
  "- Status: todo",
  "",
  "## Objective",
  "",
  "Approved by the Board in the rollout retrospective verdict.",
  "",
  "## Recent Concrete Actions",
  "",
  "- Run `dad75505-9f51-4dfa-9c22-fc7d95042025` finished with status `succeeded` at 2026-09-01T12:31:31.310Z.",
  "- Let me digest the wake payload.",
  "",
  "- I'm the CTO agent (805da696).",
  "- Wake: source_scoped_recovery_action on STA-2904.",
  "- Recovery cause: stranded_assigned_issue. Recovery attempt 1.",
  "",
  "## Commands Run",
  "",
  "- Heartbeat run `dad75505-9f51-4dfa-9c22-fc7d95042025` invoked adapter `claude_local`.",
  "",
  "## Files / Routes Touched",
  "",
  "- `packages/server/src`",
  "- `packages/adapter-utils`",
  "",
  "## Blockers / Decisions",
  "",
  "- No new blocker was recorded by the latest run.",
  "",
  "## Next Action",
  "",
  "- Resume implementation from the acceptance criteria, latest comments, and this summary.",
].join("\n");

// Replay case 2: a hand-authored summary with a wake-digest block leaked into
// the middle of it. Authored content sits outside the leaked sections; the
// trailing authored block carries its own (non-scaffold) heading, because
// unheaded content after a leaked heading belongs to that section — that is
// exactly where real wake-digest prose leaks land.
const PARTIAL_LEAK_REPLAY = [
  "Implemented the structured terminal-comment finalizer; focused tests pass.",
  "",
  "## Recent Concrete Actions",
  "",
  "- Let me digest the wake payload.",
  "- I'm the CTO agent (805da696).",
  "- Recovery cause: stranded_assigned_issue. Original assignee: Backend & Integrations Engineer.",
  "",
  "## Commands Run",
  "",
  "- Heartbeat run `dad75505` invoked adapter `claude_local`.",
  "- Fallback order: (1) send back to Backend & Integrations Engineer.",
  "",
  "## Remaining risk",
  "",
  "sanitizer is scoped to generated scaffold headings only.",
].join("\n");

describe("sanitizeProgressTranscriptMarkdown", () => {
  it("replay 1: strips a full continuation-summary scaffold", () => {
    const result = sanitizeProgressTranscriptMarkdown(FULL_SCAFFOLD_REPLAY);
    // The top-level scaffold heading records the removal; its nested scaffold
    // sections are dropped as part of that section.
    expect(result.removedHeadings).toEqual(["Continuation Summary"]);
    expect(result.text.trim()).toBe("");
    expect(result.text).not.toContain("Recent Concrete Actions");
    expect(result.text).not.toContain("Let me digest");
    expect(result.text).not.toContain("I'm the CTO agent");
    expect(result.text).not.toContain("Heartbeat run");
  });

  it("replay 2: removes only the leaked sections, keeps the authored summary", () => {
    const result = sanitizeProgressTranscriptMarkdown(PARTIAL_LEAK_REPLAY);
    expect(result.removedHeadings).toEqual(["Recent Concrete Actions", "Commands Run"]);
    expect(result.text).not.toContain("Let me digest");
    expect(result.text).not.toContain("I'm the CTO agent");
    expect(result.text).not.toContain("Heartbeat run");
    expect(result.text).not.toContain("Fallback order");
    expect(result.text).not.toContain("## Recent Concrete Actions");
    expect(result.text).toContain("Implemented the structured terminal-comment finalizer; focused tests pass.");
    expect(result.text).toContain("## Remaining risk");
    expect(result.text).toContain("sanitizer is scoped to generated scaffold headings only.");
  });

  it("leaves ordinary markdown byte-identical", () => {
    const ordinary = [
      "## Summary",
      "",
      "Shipped the finalizer.",
      "",
      "- adapters submit structured fields",
      "- comment route strips leaked scaffold",
      "",
      "### Verification",
      "",
      "| check | result |",
      "| --- | --- |",
      "| replay | pass |",
      "",
      "```sh",
      "node node_modules/vitest/vitest.mjs run terminal-comment",
      "```",
      "",
      "## Next steps",
      "## Next Action Plan for the reviewer",
      "",
      "Nothing here matches a generated scaffold heading.",
    ].join("\n");
    const result = sanitizeProgressTranscriptMarkdown(ordinary);
    expect(result.removedHeadings).toEqual([]);
    expect(result.text).toBe(ordinary);
  });

  it("treats heading matches case-insensitively and tolerates trailing punctuation", () => {
    const result = sanitizeProgressTranscriptMarkdown("ok\n\n## next action.\n\n- leaked digest line");
    expect(result.removedHeadings).toEqual(["next action."]);
    expect(result.text).toBe("ok");
  });
});

describe("renderTerminalCommentBody", () => {
  it("renders every structured field, flattened to single lines", () => {
    const body = renderTerminalCommentBody({
      status: "done — finalizer shipped\non branch feat/sdlc-terminal-comment-finalizer",
      evidence: ["focused tests pass", "route strips leaked scaffold"],
      limitation: "sanitizer is scaffold-heading scoped",
      nextOwner: "CTO review",
      disposition: "merged via PR",
    });
    expect(body).toBe([
      "**Status:** done — finalizer shipped on branch feat/sdlc-terminal-comment-finalizer",
      "",
      "**Evidence:**",
      "- focused tests pass",
      "- route strips leaked scaffold",
      "",
      "**Limitation:** sanitizer is scaffold-heading scoped",
      "",
      "**Next owner:** CTO review",
      "",
      "**Disposition:** merged via PR",
    ].join("\n"));
  });

  it("renders a minimal draft with status only", () => {
    expect(renderTerminalCommentBody({ status: "blocked on external review" }))
      .toBe("**Status:** blocked on external review");
  });
});

describe("finalizeTerminalComment", () => {
  it("renders only the terminal summary when the body is a full leaked scaffold", () => {
    const finalization = finalizeTerminalComment({
      runScoped: true,
      body: FULL_SCAFFOLD_REPLAY,
      terminal: {
        status: "done — STA-2904 finalizer implemented",
        evidence: ["two leaked-transcript replay cases render only terminal summaries"],
        nextOwner: "CTO for independent review",
        disposition: "PR opened into dev",
      },
    });
    expect(finalization.ok).toBe(true);
    if (!finalization.ok) return;
    expect(finalization.structured).toBe(true);
    expect(finalization.body).toContain("**Status:** done — STA-2904 finalizer implemented");
    expect(finalization.body).not.toContain("Let me digest");
    expect(finalization.body).not.toContain("Continuation Summary");
  });

  it("keeps a sanitized authored summary next to the structured block", () => {
    const finalization = finalizeTerminalComment({
      runScoped: true,
      body: PARTIAL_LEAK_REPLAY,
      terminal: { status: "implemented; review requested" },
    });
    expect(finalization.ok).toBe(true);
    if (!finalization.ok) return;
    expect(finalization.body).toContain("**Status:** implemented; review requested");
    expect(finalization.body).toContain("## Remaining risk");
    expect(finalization.body).toContain("sanitizer is scoped to generated scaffold headings only.");
    expect(finalization.body).not.toContain("I'm the CTO agent");
  });

  it("rejects a run-scoped comment that is only transcript scaffolding", () => {
    const finalization = finalizeTerminalComment({ runScoped: true, body: FULL_SCAFFOLD_REPLAY });
    expect(finalization).toEqual({
      ok: false,
      error: expect.stringContaining("progress-transcript scaffolding"),
    });
  });

  it("sanitizes run-scoped comments without a structured draft", () => {
    const finalization = finalizeTerminalComment({ runScoped: true, body: PARTIAL_LEAK_REPLAY });
    expect(finalization.ok).toBe(true);
    if (!finalization.ok) return;
    expect(finalization.structured).toBe(false);
    expect(finalization.body).not.toContain("## Recent Concrete Actions");
    expect(finalization.body).toContain("Implemented the structured terminal-comment finalizer");
  });

  it("leaves comments outside a run untouched", () => {
    const finalization = finalizeTerminalComment({ runScoped: false, body: FULL_SCAFFOLD_REPLAY });
    expect(finalization).toMatchObject({ ok: true, body: FULL_SCAFFOLD_REPLAY, structured: false });
  });

  it("documents the known scaffold headings it removes", () => {
    expect(PROGRESS_TRANSCRIPT_SECTION_HEADINGS).toEqual([
      "Continuation Summary",
      "Recent Concrete Actions",
      "Commands Run",
      "Files / Routes Touched",
      "Blockers / Decisions",
      "Next Action",
    ]);
  });
});
