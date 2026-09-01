// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { IssueNextActionProjection } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IssueNextActionCard } from "./IssueNextActionCard";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const baseProjection: IssueNextActionProjection = {
  kind: "monitor",
  title: "Waiting for monitor",
  description: "Paperclip will wake the assignee at the persisted monitor anchor.",
  ownerType: "system",
  ownerId: null,
  sourceId: "issue-1",
  sourceRevision: "monitor-1",
  continuationKey: "issue-continuation:v1:issue-1:key",
  scheduledAt: "2026-09-01T12:00:00.000Z",
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(projection: IssueNextActionProjection | null) {
  flushSync(() => root.render(<IssueNextActionCard projection={projection} />));
}

describe("IssueNextActionCard", () => {
  it("renders a persisted monitor as the singular next action", () => {
    render(baseProjection);

    const card = container.querySelector("[data-testid='issue-next-action']");
    expect(card?.getAttribute("data-kind")).toBe("monitor");
    expect(card?.textContent).toContain("Monitor");
    expect(card?.textContent).toContain("Waiting for monitor");
    expect(card?.textContent).not.toContain("Run retry");
  });

  it("renders a run retry distinctly from a monitor", () => {
    render({
      ...baseProjection,
      kind: "run_retry",
      title: "Run retry scheduled",
      description: "Paperclip will retry the failed run at the scheduled time.",
    });

    const card = container.querySelector("[data-testid='issue-next-action']");
    expect(card?.getAttribute("data-kind")).toBe("run_retry");
    expect(card?.textContent).toContain("Run retry");
    expect(card?.textContent).not.toContain("Monitor");
  });
});
