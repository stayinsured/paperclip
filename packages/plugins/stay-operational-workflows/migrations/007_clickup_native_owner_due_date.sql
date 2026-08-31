ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.clickup_conflicts
  DROP CONSTRAINT IF EXISTS clickup_conflicts_field_check;

ALTER TABLE plugin_stay_operational_workflows_86a3e2e7b2.clickup_conflicts
  ADD CONSTRAINT clickup_conflicts_field_check
  CHECK (field IN ('title', 'planningSummary', 'status', 'assigneeDisplay', 'blocker',
    'acceptanceSummary', 'estimate', 'nativeAssignee', 'dueDate',
    'sourceStatus', 'forecastSource', 'forecastRevision'));
