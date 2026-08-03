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
    How often the worker **ticks**, as an EventBridge Scheduler expression.

    This is not when any briefing runs. A job's own cadence lives in Postgres,
    as `jobs.schedule_cron` and `jobs.schedule_timezone`, and the worker asks
    what is due on every tick — so adding a second job with a different cadence
    costs an INSERT rather than an apply. What is left here is the tick, which
    is the same for every job and therefore has nothing to drift.

    Hourly is the resolution of the whole system: a job's schedule can name any
    hour in any timezone, but nothing finer than this is observable. Making it
    finer multiplies cold starts and Neon wakes for cadences nobody has asked
    for; making it coarser silently rounds every job's schedule.

    Note the dialect: EventBridge has no seconds field and requires `?` in
    exactly one of day-of-month or day-of-week, so hourly on the hour is
    `cron(0 * * * ? *)` rather than the five-field crontab it resembles.
  EOT
  type        = string
  default     = "cron(0 * * * ? *)"
}

variable "schedule_timezone" {
  description = <<-EOT
    Timezone the **tick** is evaluated in, not the timezone any briefing runs
    in — that is `jobs.schedule_timezone`, per job, and an IANA name.

    UTC by default. On an hourly tick this barely matters, since every zone's
    hour boundary is this one's; it stays UTC so the tick agrees with the UTC
    timestamps in the run reports, and so a zone that observes a sub-hour offset
    cannot shift the tick off the hour.
  EOT
  type        = string
  default     = "UTC"
}

variable "schedule_enabled" {
  description = "Whether the hourly tick fires. Set false to keep the function deployable and manually invocable while it is not on duty — the safe half of a cutover, and the half to deploy first when the worker and its schedule change meaning together."
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

variable "user_storage_bucket_name" {
  description = <<-EOT
    Bucket the worker writes briefs to, passed to the function as
    `USER_STORAGE_BUCKET_NAME`.

    No default, and not derived here. The bucket belongs to the user-storage
    stack, so the root wires its output in — which is also what orders the two
    stacks, since a worker deployed ahead of its bucket would fail every run at
    the upload rather than at the apply.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.user_storage_bucket_name))
    error_message = "user_storage_bucket_name must be a valid S3 bucket name."
  }
}

variable "user_storage_environment" {
  description = <<-EOT
    Which environment prefix the worker writes under, passed to the function as
    `USER_STORAGE_ENVIRONMENT`. It is the first segment of every object key.

    This, not the IAM attachment, is what decides where briefs land. The root
    attaches every environment's `:briefs` policy so a second environment costs
    no edit there, which means the grant is deliberately wider than the
    behaviour — this value is the narrowing.
  EOT
  type        = string
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*$", var.user_storage_environment))
    error_message = "user_storage_environment must be lowercase alphanumeric with hyphens, matching the user-storage module's environment names."
  }
}

variable "langfuse_base_url" {
  description = "Langfuse API base URL. Use the regional cloud endpoint or the self-hosted deployment URL; API keys remain Secrets Manager values."
  type        = string
  default     = "https://cloud.langfuse.com"

  validation {
    condition     = startswith(var.langfuse_base_url, "https://")
    error_message = "langfuse_base_url must use HTTPS."
  }
}

variable "langfuse_tracing_environment" {
  description = "Langfuse environment recorded on worker traces."
  type        = string
  default     = "production"

  validation {
    condition     = length(trimspace(var.langfuse_tracing_environment)) > 0
    error_message = "langfuse_tracing_environment must not be empty."
  }
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
