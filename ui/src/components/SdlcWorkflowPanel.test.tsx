// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { SdlcWorkflowSummary } from "../lib/sdlc-workflow";
import { SdlcWorkflowPanelContent } from "./SdlcWorkflowPanel";

vi.mock("../lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(summary: SdlcWorkflowSummary) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root?.render(<MemoryRouter><SdlcWorkflowPanelContent summary={summary} /></MemoryRouter>));
  return container;
}

const summary: SdlcWorkflowSummary = {
  riskClass: "C3",
  decision: {
    owner: "board",
    state: "action",
    label: "Board decision needed · Gate 2 · start authorization",
    detail: "Authorize implementation against plan revision 2?",
  },
  gate1: {
    gate: "gate1",
    label: "Gate 1 · plan approval",
    state: "accepted",
    detail: "Plan 12345678",
    reason: null,
    interactionId: "gate-1",
  },
  gate2: {
    gate: "gate2",
    label: "Gate 2 · start authorization",
    state: "pending",
    detail: "Authorize implementation against plan revision 2?",
    reason: null,
    interactionId: "gate-2",
  },
  startRows: [
    { id: "dor", label: "Plan readiness (DoR)", state: "pass", detail: "Current plan passed." },
    { id: "gate2", label: "Gate 2", state: "pending", detail: "Board decision is pending." },
  ],
  completionRows: [
    { id: "ac-1", label: "Board sees missing evidence", state: "pending", detail: "Missing check, QA, UAT, or waiver evidence." },
    { id: "review:qa", label: "Independent review", state: "fail", detail: "Latest QA verdict did not pass." },
  ],
  providers: [
    { provider: "clickup", state: "fail", detail: "2 unresolved drift items." },
    { provider: "outline", state: "pass", detail: "Latest readback is verified." },
  ],
  evidenceLinks: [
    { id: "pr", label: "PR link", href: "https://example.test/pr/1" },
  ],
  tasks: [
    {
      issueId: "task-1",
      identifier: "STA-2784",
      title: "Add Board-facing workflow and evidence views",
      status: "in_review",
      plannedOwner: "Web Platform Engineer",
      estimate: "3 person-days",
      dueDate: "2026-09-15",
      startState: "pass",
      startDetail: "Started (in_review).",
      completionState: "pending",
      completionDetail: "2 acceptance evidence items missing.",
    },
  ],
};

describe("SdlcWorkflowPanelContent", () => {
  it("puts the Board decision, rejection evidence, and missing rows above activity-log detail", () => {
    const node = render(summary);
    expect(node.querySelector('[data-testid="sdlc-workflow-panel"]')).not.toBeNull();
    expect(node.querySelector('[data-decision-state="action"]')?.textContent).toContain("Board decision needed");
    expect(node.querySelector('[data-gate-state="pending"]')?.textContent).toContain("Board decision");
    expect(node.textContent).toContain("Board sees missing evidence");
    expect(node.textContent).toContain("Independent review");
    expect(node.textContent).toContain("Latest QA verdict did not pass");
    expect(node.textContent).toContain("2 unresolved drift items");
  });

  it("shows planned owner/date and exposes evidence as a safe external link", () => {
    const node = render(summary);
    const details = node.querySelector("details");
    expect(details?.textContent).toContain("Web Platform Engineer");
    expect(details?.textContent).toContain("3 person-days · 2026-09-15");
    const link = node.querySelector<HTMLAnchorElement>('a[href="https://example.test/pr/1"]');
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noreferrer");
  });
});
