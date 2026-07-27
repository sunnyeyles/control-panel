variable "function_name" {
  description = "Name of the worker Lambda. Also prefixes its roles, schedule and secret."
  type        = string
  default     = "briefing-worker"
}

variable "lambda_zip_path" {
  description = <<-EOT
    Path to the built deployment package. Null uses the package's own build
    output, resolved against this directory.

    Read at plan time, so the zip must exist before `terraform plan`:
    `pnpm turbo zip --filter=@workspace/briefing-worker`.
  EOT
  type        = string
  default     = null
}

variable "alert_email" {
  description = "Address for worker failure and missed-run alarms. No default: alerting that silently switches itself off is the failure it exists to catch."
  type        = string
}

variable "schedule_enabled" {
  description = "Whether the daily schedule fires. Set false to deploy the worker without putting it on duty — useful while the Azure timer is still running, since two live schedules would do the day's work twice."
  type        = bool
  default     = true
}

variable "user_storage_policy_arns" {
  description = <<-EOT
    User-storage IAM policy ARNs to attach to the worker's execution role.

    Prefer the per-(environment, kind) grants — `prod:briefs` rather than
    `prod` — so the worker carries authority over the category it writes and
    nothing else.

    Empty by default so this root is applyable before the storage stack exists.
  EOT
  type        = map(string)
  default     = {}
}
