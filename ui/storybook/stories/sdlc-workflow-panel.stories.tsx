import type { Meta, StoryObj } from "@storybook/react-vite";
import { SdlcWorkflowError, SdlcWorkflowPanelContent } from "@/components/SdlcWorkflowPanel";
import type { SdlcWorkflowSummary } from "@/lib/sdlc-workflow";

const boardDecisionSummary: SdlcWorkflowSummary = {
  riskClass: "C3",
  decision: {
    owner: "board",
    state: "action",
    label: "Board decision needed · Gate 2 · start authorization",
    detail: "Authorize implementation against the accepted plan and verified graph revision 4?",
  },
  gate1: {
    gate: "gate1",
    label: "Gate 1 · plan approval",
    state: "accepted",
    detail: "Plan ff68aad9",
    reason: null,
    interactionId: "gate-1",
  },
  gate2: {
    gate: "gate2",
    label: "Gate 2 · start authorization",
    state: "pending",
    detail: "Authorize implementation against the accepted plan and verified graph revision 4?",
    reason: null,
    interactionId: "gate-2",
  },
  startRows: [
    { id: "dor", label: "Plan readiness (DoR)", state: "pass", detail: "The current plan revision passed readiness validation." },
    { id: "gate1", label: "Gate 1 · plan approval", state: "pass", detail: "Plan ff68aad9." },
    { id: "provisioning", label: "Task graph readback", state: "pass", detail: "13 tasks verified in graph 4." },
    { id: "gate2", label: "Gate 2 · start authorization", state: "pending", detail: "Board decision is pending." },
    { id: "blockers", label: "Start blockers", state: "pass", detail: "No unresolved dependency blocks this task." },
  ],
  completionRows: [
    { id: "ac-1", label: "Board can see the needed decision without reading activity logs", state: "pending", detail: "Missing check, QA, UAT, or waiver evidence." },
    { id: "ac-2", label: "Token-gate checks pass", state: "pass", detail: "Covered by check result." },
    { id: "review:pr", label: "Implementation handoff", state: "pass", detail: "Task branch and PR evidence are recorded." },
    { id: "review:independent", label: "Independent review", state: "pending", detail: "Independent QA or Board confirmation is missing." },
  ],
  providers: [
    { provider: "clickup", state: "fail", detail: "2 unresolved drift items." },
    { provider: "outline", state: "pass", detail: "Latest readback is verified." },
  ],
  evidenceLinks: [
    { id: "plan", label: "outline provider readback", href: "https://example.com/plan" },
    { id: "pr", label: "PR link", href: "https://example.com/pr/42" },
  ],
  tasks: [
    {
      issueId: "task-g",
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
    {
      issueId: "task-h",
      identifier: "STA-2785",
      title: "Instrument workflow observability and Sentry",
      status: "backlog",
      plannedOwner: "DevOps Engineer",
      estimate: "2 person-days",
      dueDate: "2026-09-15",
      startState: "pending",
      startDetail: "Waiting for Gate 2.",
      completionState: "pending",
      completionDetail: "3 acceptance evidence items missing.",
    },
  ],
};

const rejectedSummary: SdlcWorkflowSummary = {
  ...boardDecisionSummary,
  decision: {
    owner: "delivery",
    state: "blocked",
    label: "Gate 2 · start authorization must be resolved",
    detail: "Reduce the rollout scope and submit a new revision-bound confirmation.",
  },
  gate2: {
    ...boardDecisionSummary.gate2,
    state: "rejected",
    detail: "The requested decision was rejected.",
    reason: "Reduce the rollout scope and submit a new revision-bound confirmation.",
  },
};

const meta = {
  title: "Control Plane/SDLC Workflow Panel",
  component: SdlcWorkflowPanelContent,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => <div className="mx-auto max-w-5xl"><Story /></div>,
  ],
} satisfies Meta<typeof SdlcWorkflowPanelContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BoardDecisionNeeded: Story = { args: { summary: boardDecisionSummary } };
export const GateRejected: Story = { args: { summary: rejectedSummary } };
export const EvidenceUnavailable: Story = {
  args: { summary: boardDecisionSummary },
  render: () => <SdlcWorkflowError message="Evidence line 7 is not valid JSON." />,
};
