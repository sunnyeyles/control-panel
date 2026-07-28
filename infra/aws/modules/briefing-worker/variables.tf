variable "function_name" {
  description = "Name of the Lambda function. Also prefixes the schedule, the roles and the secret, so every resource in this module is findable from it."
  type        = string

  # No default: the caller's root declares one, and a default in both places
  # would be dead code here — passing `null` to a module input does not fall
  # back to a module default.

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

    Note the dialect: EventBridge has no seconds field and requires `?` in
    exactly one of day-of-month or day-of-week, so daily at 09:00 is
    `cron(0 9 * * ? *)` rather than the five-field crontab it resembles.
  EOT
  type        = string
  default     = "cron(0 9 * * ? *)"
}

variable "schedule_timezone" {
  description = "Timezone the schedule is evaluated in. UTC by default, so the daily slot does not move under daylight saving and the schedule agrees with the UTC timestamps in the run reports."
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
    under Lambda's 900s hard maximum without letting a wedged run burn it.
  EOT
  type        = number
  default     = 600

  validation {
    condition     = var.timeout > 0 && var.timeout <= 900
    error_message = "timeout must be between 1 and 900 seconds, Lambda's hard maximum."
  }
}

variable "log_retention_days" {
  description = "How long run reports are kept. 30 days is long enough to answer 'did it run, and what happened' for any slot still worth asking about."
  type        = number
  default     = 30
}

variable "alerts_topic_arn" {
  description = <<-EOT
    SNS topic the failure and missed-run alarms publish to. Owned by the root,
    which runs one topic for every stack.

    No default, on purpose. Alerting that silently switches itself off is the
    exact failure these alarms exist to catch, so an unset value must break the
    apply rather than quietly produce an unmonitored worker.
  EOT
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:sns:", var.alerts_topic_arn))
    error_message = "alerts_topic_arn must be an SNS topic ARN."
  }
}

variable "permissions_boundary_arn" {
  description = <<-EOT
    Permissions boundary applied to both roles this module creates.

    Not decoration. The role that deploys this module holds `iam:CreateRole` and
    `iam:AttachRolePolicy`, and its own policy only permits those when the target
    carries this boundary — so leaving this null does not produce an unbounded
    role, it produces an access-denied on the next apply.

    Null is still allowed, for using this module from a root that governs IAM
    some other way.
  EOT
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags applied verbatim to every resource this module creates. The module adds nothing of its own — the root owns the tag taxonomy, so `Component` comes from there rather than being merged in here where it could disagree."
  type        = map(string)
  default     = {}
}
