---
name: paperclip-workspace-hygiene
description: >
  Prevent, diagnose, and safely recover Paperclip execution-workspace disk
  growth. Use when a managed SSH/sandbox/QA workspace will install dependencies
  or produce large artifacts, when disk/ENOSPC pressure appears, or when
  terminal run directories need retention cleanup. Not for generic performance
  tuning or database-backup administration.
---

# Paperclip Workspace Hygiene

Keep source and durable deliverables recoverable without multiplying
reproducible data per heartbeat run.

## Classify before copying

Treat these as reproducible and exclude them from workspace transfers,
archives, evidence bundles, and restore payloads:

- dependency trees and package stores such as node_modules, vendor,
  .pnpm-store, and package-manager caches
- build/runtime caches such as .turbo, .vite, .next, and .cache
- ordinary compiled output such as dist, build, and out, unless that output is
  the explicit user-inspectable deliverable

Preserve source, lock files, configuration, migrations, committed history,
documents, and the smallest useful evidence/artifact set.

## Before heavy workspace work

1. Check filesystem headroom and the current workspace size.
2. Reuse an environment-level package store when the runtime exposes one; never
   configure a package store inside a run-specific workspace.
3. Prefer targeted installs/builds over duplicate full-repository worktrees.
4. If an expected transfer or artifact is unusually large, report the estimate
   and split or compress the deliverable instead of bypassing a platform limit.

Do not disable a transfer/disk limit merely to make a run pass. An explicit
operator decision is required when a real workload cannot fit the configured
budget.

## During the run

- Keep screenshots, traces, reports, and downloads scoped to the current issue.
- Upload the final inspectable artifact through Paperclip; do not retain
  duplicate browser/build caches as evidence.
- Use managed runtime services for persistent servers. Do not leave detached
  processes as an implicit retention mechanism.
- A workspace that reaches a terminal run state has no right to retain
  reproducible caches.

## Capacity response

- At 70% host use: identify the growing container/run and warn.
- At 80%: stop starting additional heavy work, run the reviewed retention path,
  and surface a visible blocker if headroom is not restored.
- At 90%: fail closed for new workspace transfers. Preserve databases, named
  volumes, credentials, active run state, and current rollback material.

Never recursively delete a broad path, Docker volume, database directory,
browser profile, credential home, or an active/open run. Resolve exact run IDs
from Paperclip and open process paths before deleting anything.

## Cleanup and evidence

Use the host's allowlisted Paperclip retention script in dry-run mode first.
Apply mode may remove only terminal/quiet run directories and named
reproducible cache directories under the configured QA runtime root.

After cleanup, record:

- filesystem used/free space
- affected container writable size
- deleted or cache-stripped run IDs
- protected live/open run IDs
- the next deterministic prevention control

This skill supplies decision guidance, not authorization. Existing approval,
company, workspace, and destructive-action boundaries still apply.
