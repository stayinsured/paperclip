-- STA-2285: relax the structural shadow-only limits for the outline module only,
-- behind the board-approved activation payload. Defaults remain zero-write:
-- every other module keeps read_only=true / destination_enabled=false, and an
-- outline config without outline_activation still fails closed at validation.

ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  ADD COLUMN outline_activation jsonb;

ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  DROP CONSTRAINT IF EXISTS project_configs_read_only_check;
ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  ADD CONSTRAINT project_configs_read_only_scope_check
  CHECK (read_only = true OR module = 'outline');

ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  DROP CONSTRAINT IF EXISTS project_configs_destination_enabled_check;
ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  ADD CONSTRAINT project_configs_destination_enabled_scope_check
  CHECK (destination_enabled = false OR module = 'outline');

ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  ADD CONSTRAINT project_configs_outline_activation_module_check
  CHECK (outline_activation IS NULL OR module = 'outline');

ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  ADD CONSTRAINT project_configs_outline_activation_shape_check
  CHECK (
    outline_activation IS NULL
    OR (
      jsonb_typeof(outline_activation) = 'object'
      AND outline_activation ? 'destination'
      AND outline_activation ? 'authorization'
    )
  );

ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.operations
  DROP CONSTRAINT IF EXISTS operations_status_check;
ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.operations
  ADD CONSTRAINT operations_status_check
  CHECK (status IN ('pending', 'retry_wait', 'reconciling', 'shadowed', 'published', 'skipped', 'failed', 'conflict'));

ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.reconciliation_runs
  DROP CONSTRAINT IF EXISTS reconciliation_runs_external_write_count_check;
ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.reconciliation_runs
  ADD CONSTRAINT reconciliation_runs_external_write_count_nonnegative_check
  CHECK (external_write_count >= 0);

ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.reconciliation_runs
  ADD COLUMN published_count integer NOT NULL DEFAULT 0 CHECK (published_count >= 0);
