CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.clickup_task_links (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  list_id text NOT NULL,
  task_id text NOT NULL,
  task_url text,
  origin_side text NOT NULL CHECK (origin_side IN ('paperclip', 'clickup')),
  correlation_value_hash text NOT NULL,
  base_snapshot jsonb NOT NULL,
  last_projection_version text NOT NULL,
  last_external_revision text,
  status text NOT NULL CHECK (status IN ('healthy', 'conflict', 'error')),
  last_projected_at timestamptz,
  last_reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, issue_id),
  UNIQUE (company_id, list_id, task_id)
);

CREATE INDEX clickup_task_links_company_health_idx
  ON plugin_stay_operational_workflows_86a3e2e7b2.clickup_task_links
  (company_id, status, last_reconciled_at);

CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.clickup_conflicts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES plugin_stay_operational_workflows_86a3e2e7b2.clickup_task_links(id) ON DELETE CASCADE,
  conflict_key text NOT NULL,
  field text NOT NULL CHECK (field IN ('title', 'planningSummary', 'status', 'assigneeDisplay', 'blocker', 'acceptanceSummary', 'estimate')),
  base_value jsonb NOT NULL,
  external_value jsonb NOT NULL,
  paperclip_value jsonb NOT NULL,
  external_updated_at timestamptz NOT NULL,
  paperclip_updated_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, conflict_key)
);

CREATE INDEX clickup_conflicts_visible_idx
  ON plugin_stay_operational_workflows_86a3e2e7b2.clickup_conflicts
  (company_id, status, detected_at DESC);
