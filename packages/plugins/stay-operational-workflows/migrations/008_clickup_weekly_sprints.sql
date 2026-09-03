-- Paperclip-owned weekly sprint intervals and idempotent ClickUp intake links.
-- A null timezone deliberately means UTC; runtime validation rejects invalid IANA zones and overlap.
CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.weekly_sprints (
  id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE, name text NOT NULL,
  start_date date NOT NULL, end_date date NOT NULL, timezone text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_date < end_date), UNIQUE (company_id, project_id, start_date, end_date)
);
CREATE INDEX weekly_sprints_scope_idx ON plugin_stay_operational_workflows_86a3e2e7b2.weekly_sprints (company_id, project_id, start_date, end_date);
CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.clickup_issue_sprint_links (
  id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  sprint_id uuid NOT NULL REFERENCES plugin_stay_operational_workflows_86a3e2e7b2.weekly_sprints(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, issue_id, sprint_id)
);
CREATE INDEX clickup_issue_sprint_links_scope_idx ON plugin_stay_operational_workflows_86a3e2e7b2.clickup_issue_sprint_links (company_id, project_id, sprint_id, issue_id);
