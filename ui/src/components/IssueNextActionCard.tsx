import {
  Ban,
  CheckCircle2,
  Clock3,
  FileCheck2,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import type { IssueNextActionKind, IssueNextActionProjection } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { cn, formatDateTime } from "@/lib/utils";

const presentation: Record<
  IssueNextActionKind,
  { label: string; Icon: LucideIcon; className: string }
> = {
  approval: {
    label: "Approval",
    Icon: CheckCircle2,
    className: "border-primary/30 bg-primary/10 text-primary",
  },
  evidence: {
    label: "Evidence",
    Icon: FileCheck2,
    className: "border-border bg-secondary text-secondary-foreground",
  },
  blocker: {
    label: "Blocker",
    Icon: Ban,
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  monitor: {
    label: "Monitor",
    Icon: Clock3,
    className: "border-border bg-muted text-muted-foreground",
  },
  run_retry: {
    label: "Run retry",
    Icon: RotateCcw,
    className: "border-primary/30 bg-primary/10 text-primary",
  },
};

export function IssueNextActionCard({
  projection,
}: {
  projection: IssueNextActionProjection | null | undefined;
}) {
  if (!projection) return null;

  const { Icon, label, className } = presentation[projection.kind];

  return (
    <section
      className="mb-3 rounded-lg border border-border bg-card px-3 py-3 text-card-foreground"
      data-testid="issue-next-action"
      data-kind={projection.kind}
      aria-label="Next action"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Next action
        </span>
        <Badge variant="outline" className={cn(className)}>
          <Icon aria-hidden="true" />
          {label}
        </Badge>
      </div>
      <h3 className="mt-2 text-sm font-medium">{projection.title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{projection.description}</p>
      {projection.scheduledAt ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Scheduled for {formatDateTime(projection.scheduledAt)}
        </p>
      ) : null}
    </section>
  );
}

