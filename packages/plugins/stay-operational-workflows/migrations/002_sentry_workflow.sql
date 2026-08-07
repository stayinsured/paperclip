CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.sentry_configs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  polling_enabled boolean NOT NULL DEFAULT false,
  slack_enabled boolean NOT NULL DEFAULT false,
  policy_version text NOT NULL,
  config_json jsonb NOT NULL,
  config_fingerprint text NOT NULL,
  created_by_actor_type text NOT NULL,
  created_by_actor_id text,
  created_by_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, project_id)
);

CREATE INDEX sentry_configs_company_enabled_idx
  ON plugin_stay_operational_workflows_86a3e2e7b2.sentry_configs (company_id, polling_enabled, project_id);

CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.sentry_poll_runs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('incremental', 'daily_backscan', 'manual')),
  status text NOT NULL CHECK (status IN ('running', 'retry_wait', 'completed', 'failed')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  next_cursor text,
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  observed_count integer NOT NULL DEFAULT 0 CHECK (observed_count >= 0),
  next_attempt_at timestamptz,
  last_error_code text,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_by_run_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sentry_poll_runs_one_active_idx
  ON plugin_stay_operational_workflows_86a3e2e7b2.sentry_poll_runs (company_id, project_id)
  WHERE status IN ('running', 'retry_wait');

CREATE INDEX sentry_poll_runs_history_idx
  ON plugin_stay_operational_workflows_86a3e2e7b2.sentry_poll_runs (company_id, project_id, started_at DESC);

CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.sentry_issue_states (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  sentry_organization_id text NOT NULL,
  sentry_project_id text NOT NULL,
  stable_sentry_issue_id text NOT NULL,
  identity_key text NOT NULL,
  sanitized_snapshot jsonb NOT NULL,
  triage_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolved_count integer,
  current_proposal_revision_id uuid,
  current_confirmation_id uuid,
  remediation_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  last_notified_revision_id uuid,
  consecutive_slack_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_slack_failures >= 0),
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, sentry_organization_id, sentry_project_id, stable_sentry_issue_id),
  UNIQUE (company_id, identity_key)
);

CREATE INDEX sentry_issue_states_triage_idx
  ON plugin_stay_operational_workflows_86a3e2e7b2.sentry_issue_states (company_id, triage_issue_id);

CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.sentry_notifications (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  sentry_issue_state_id uuid NOT NULL REFERENCES plugin_stay_operational_workflows_86a3e2e7b2.sentry_issue_states(id) ON DELETE CASCADE,
  triage_issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  proposal_revision_id uuid NOT NULL,
  notification_key text NOT NULL,
  team_id text NOT NULL,
  channel_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'retry_wait', 'sent', 'reconciling', 'failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  outcome_receipt jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, notification_key)
);

CREATE INDEX sentry_notifications_retry_idx
  ON plugin_stay_operational_workflows_86a3e2e7b2.sentry_notifications (company_id, status, next_attempt_at);
