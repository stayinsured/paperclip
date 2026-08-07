CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.outline_assessments (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  policy_version text NOT NULL,
  assessment_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'material', 'not_material', 'needs_review')),
  assessment jsonb,
  preview jsonb,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  observation_count integer NOT NULL DEFAULT 1 CHECK (observation_count >= 1),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  assessed_at timestamptz,
  created_by_actor_type text NOT NULL,
  created_by_actor_id text,
  created_by_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, source_issue_id, policy_version),
  UNIQUE (company_id, assessment_key)
);

CREATE INDEX outline_assessments_pending_idx
  ON plugin_stay_operational_workflows_86a3e2e7b2.outline_assessments
  (company_id, status, requested_at)
  WHERE status = 'pending';

CREATE INDEX outline_assessments_preview_idx
  ON plugin_stay_operational_workflows_86a3e2e7b2.outline_assessments
  (company_id, assessed_at DESC)
  WHERE preview IS NOT NULL;
