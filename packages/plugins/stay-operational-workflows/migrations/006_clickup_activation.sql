-- Activate one approved Paperclip-authoritative ClickUp mirror.
-- The outer config switches remain the reversible kill switch. The worker also
-- revalidates the immutable workspace/list boundary, accepted fingerprint,
-- current least-privilege proof, and secret-ref identity before every request.

ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  ADD COLUMN IF NOT EXISTS clickup_activation jsonb;

ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  DROP CONSTRAINT IF EXISTS project_configs_read_only_scope_check;
ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  ADD CONSTRAINT project_configs_read_only_scope_check
  CHECK (read_only = true OR module IN ('outline', 'clickup'));

ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  DROP CONSTRAINT IF EXISTS project_configs_destination_enabled_scope_check;
ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  ADD CONSTRAINT project_configs_destination_enabled_scope_check
  CHECK (destination_enabled = false OR module IN ('outline', 'clickup'));

ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  DROP CONSTRAINT IF EXISTS project_configs_clickup_activation_module_check;
ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  ADD CONSTRAINT project_configs_clickup_activation_module_check
  CHECK (clickup_activation IS NULL OR module = 'clickup');

ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  DROP CONSTRAINT IF EXISTS project_configs_clickup_activation_shape_check;
ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.project_configs
  ADD CONSTRAINT project_configs_clickup_activation_shape_check
  CHECK (
    clickup_activation IS NULL
    OR (
      jsonb_typeof(clickup_activation) = 'object'
      AND clickup_activation ? 'paperclipBaseUrl'
      AND clickup_activation ? 'tokenRef'
      AND clickup_activation ? 'destination'
      AND clickup_activation ? 'authorization'
    )
  );
