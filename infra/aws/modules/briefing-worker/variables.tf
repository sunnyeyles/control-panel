variable "function_name" {
  description = "Name of the Lambda function. Also prefixes the schedule, the roles and the secret, so every resource in this module is findable from it."
  type        = string
  default     = "briefing-worker"

  validation {
    condition     = can(regex("^[a-zA-Z0-9-_]{1,64}$", var.function_name))
    error_message = "function_name must be 1-64 characters of letters, digits, hyphens or underscores."
  }
}

variable "lambda_zip_path" {
  description = <<-EOT
    Path to the built deployment package, relative to the root module.

    Read at plan time by filebase64sha256, so the zip must already exist before
    `terraform plan` runs. Build first — `pnpm turbo zip --filter=@workspace/briefing-worker`
    — or plan fails with a file-not-found that reads like a Terraform bug.
  EOT
  type        = string
}

variable "schedule_expression" {
  description = <<-EOT
    When the worker runs, as an EventBridge Scheduler expression.

    The default is the Azure NCRONTAB `0 0 9 * * *` translated: AWS has no
    seconds field and requires `?` in exactly one of day-of-month or
    day-of-week, so daily at 09:00 becomes `cron(0 9 * * ? *)`.
  EOT
  type        = string
  default     = "cron(0 9 * * ? *)"
}

variable "schedule_timezone" {
  description = "Timezone the schedule is evaluated in. UTC matches the Azure timer, which had no timezone setting and so was UTC by construction."
  type        = string
  default     = "UTC"
}

variable "schedule_enabled" {
  description = "Whether the daily schedule fires. Set false to keep the function deployable and manually invocable while it is not on duty — the safe half of a cutover."
  type        = bool
  default     = true
}

variable "memory_size" {
  description = <<-EOT
    Memory in MB. On Lambda this mainly buys CPU, and the work here is I/O-bound
    on the OpenAI API rather than CPU-bound, so it chiefly affects how fast the
    ~4 MB bundle parses on a cold start. Tune from the `Max Memory Used` field
    in the CloudWatch REPORT line rather than by guessing.
  EOT
  type        = number
  default     = 1024
}

variable "timeout" {
  description = <<-EOT
    Invocation timeout in seconds. The agent loop is bounded at 10 LLM calls;
    at a worst-case 30s each, a 300s ceiling would cut off a legitimately slow
    run, and a truncated run looks identical to a hung one. 600 leaves headroom
    under Lambda's 900s maximum and is a tightening of Azure's 30-minute limit.
  EOT
  type        = number
  default     = 600

  validation {
    condition     = var.timeout > 0 && var.timeout <= 900
    error_message = "timeout must be between 1 and 900 seconds, Lambda's hard maximum."
  }
}

variable "log_retention_days" {
  description = "How long run reports are kept, matching the 30 days Log Analytics was configured with."
  type        = number
  default     = 30
}

variable "alert_email" {
  description = <<-EOT
    Address that receives failure and missed-run alarms.

    No default, on purpose. Alerting that silently switches itself off is the
    exact failure the alarm exists to catch, so an unset value must break the
    apply rather than quietly produce an unmonitored worker. AWS sends a
    confirmation mail that must be clicked before anything is delivered.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.alert_email))
    error_message = "alert_email must be a single valid email address."
  }
}

variable "tags" {
  description = "Tags applied to every resource this module creates."
  type        = map(string)
  default     = {}
}
