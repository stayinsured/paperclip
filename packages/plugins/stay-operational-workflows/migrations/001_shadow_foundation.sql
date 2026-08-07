CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  module text NOT NULL CHECK (module IN ('outline', 'clickup', 'sentry_slack')),
  enabled boolean NOT NULL DEFAULT false,
  read_only boolean NOT NULL DEFAULT true CHECK (read_only = true),
  destination_enabled boolean NOT NULL DEFAULT false CHECK (destination_enabled = false),
  destination_key text,
  source_version text NOT NULL,
  policy_version text NOT NULL,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  base_delay_ms integer NOT NULL DEFAULT 1000 CHECK (base_delay_ms BETWEEN 100 AND 60000),
  max_delay_ms integer NOT NULL DEFAULT 300000 CHECK (max_delay_ms BETWEEN 1000 AND 3600000),
  overlap_seconds integer NOT NULL DEFAULT 300 CHECK (overlap_seconds BETWEEN 0 AND 3600),
  batch_size integer NOT NULL DEFAULT 200 CHECK (batch_size BETWEEN 1 AND 1000),
  created_by_actor_type text NOT NULL,
  created_by_actor_id text,
  created_by_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, project_id, module)
);

CREATE INDEX project_configs_company_enabled_idx
  ON plugin_stay_operational_workflows_86a3e2e7b2.project_configs (company_id, enabled, project_id, module);

CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.operations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  module text NOT NULL CHECK (module IN ('outline', 'clickup', 'sentry_slack')),
  operation_key text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_version text NOT NULL,
  policy_version text NOT NULL,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  status text NOT NULL CHECK (status IN ('pending', 'retry_wait', 'reconciling', 'shadowed', 'skipped', 'failed', 'conflict')),
  outcome_identity text NOT NULL,
  outcome_receipt jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  cursor_value text NOT NULL,
  created_by_actor_type text NOT NULL,
  created_by_actor_id text,
  created_by_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, module, operation_key)
);

CREATE INDEX operations_retry_idx
  ON plugin_stay_operational_workflows_86a3e2e7b2.operations (company_id, status, next_attempt_at);
CREATE INDEX operations_source_idx
  ON plugin_stay_operational_workflows_86a3e2e7b2.operations (company_id, module, source_kind, source_id);

CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.mappings (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  module text NOT NULL CHECK (module IN ('outline', 'clickup', 'sentry_slack')),
  source_kind text NOT NULL,
  source_id text NOT NULL,
  destination_identity_hash text NOT NULL,
  source_version text NOT NULL,
  policy_version text NOT NULL,
  operation_key text NOT NULL,
  created_by_actor_type text NOT NULL,
  created_by_actor_id text,
  created_by_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, module, source_kind, source_id)
);

CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.cursors (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  module text NOT NULL CHECK (module IN ('outline', 'clickup', 'sentry_slack')),
  cursor_key text NOT NULL,
  cursor_value text NOT NULL,
  source_version text NOT NULL,
  last_operation_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, project_id, module, cursor_key)
);

CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.exceptions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  module text NOT NULL CHECK (module IN ('outline', 'clickup', 'sentry_slack')),
  operation_id uuid REFERENCES plugin_stay_operational_workflows_86a3e2e7b2.operations(id) ON DELETE CASCADE,
  exception_key text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  summary_redacted text NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  created_by_actor_type text NOT NULL,
  created_by_actor_id text,
  created_by_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, exception_key)
);

CREATE INDEX exceptions_visible_idx
  ON plugin_stay_operational_workflows_86a3e2e7b2.exceptions (company_id, status, module, created_at DESC);

CREATE TABLE plugin_stay_operational_workflows_86a3e2e7b2.reconciliation_runs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'event', 'manual', 'retry')),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  scanned_count integer NOT NULL DEFAULT 0,
  shadowed_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  conflict_count integer NOT NULL DEFAULT 0,
  exception_count integer NOT NULL DEFAULT 0,
  external_write_count integer NOT NULL DEFAULT 0 CHECK (external_write_count = 0),
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_type text NOT NULL,
  created_by_actor_id text,
  created_by_run_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reconciliation_runs_company_idx
  ON plugin_stay_operational_workflows_86a3e2e7b2.reconciliation_runs (company_id, created_at DESC);
