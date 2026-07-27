# EventBridge Scheduler rather than an EventBridge Rule.
#
# Scheduler is the purpose-built service for this: a single daily job stays off
# the default event bus, the timezone is a first-class argument rather than
# something to emulate in the cron string, and the target is invoked through an
# assumed role — so permission lives in iam.tf alone instead of being split
# between a role here and a resource-based policy on the function.
resource "aws_scheduler_schedule" "daily" {
  name        = "${var.function_name}-daily"
  description = "Daily run of the briefing worker."
  state       = var.schedule_enabled ? "ENABLED" : "DISABLED"

  schedule_expression          = var.schedule_expression
  schedule_expression_timezone = var.schedule_timezone

  # OFF, not a window. A briefing dated by the day it ran does not care about a
  # few minutes, but a fixed time makes "did today's run happen?" answerable by
  # looking at one moment rather than a range.
  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.worker.arn
    role_arn = aws_iam_role.scheduler.arn

    # Zero, which is not the default. Scheduler retries 185 times over 24 hours
    # unless told otherwise, and for an LLM job that means re-billing a failing
    # run all day and emitting 186 `proof-run` failure lines where the daily
    # check expects exactly one. A failed run waits for tomorrow's slot — the
    # same decision the Azure deployment recorded, kept deliberately rather
    # than inherited by accident.
    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}
