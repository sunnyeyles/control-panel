# EventBridge Scheduler rather than an EventBridge Rule.
#
# Scheduler keeps a single recurring job off the default event bus, takes the
# timezone as a first-class argument rather than emulating it in cron, and
# invokes through an assumed role — so permission lives in iam.tf alone.
#
# This is now a **tick**: it fires hourly, the worker asks the database what is
# due, and no job's own schedule appears here. The resource keeps its old name
# so the cutover was an update rather than a destroy-and-create.
resource "aws_scheduler_schedule" "daily" {
  name        = "${var.function_name}-daily"
  description = "Hourly tick: wakes the briefing worker to run whatever jobs are due."
  state       = var.schedule_enabled ? "ENABLED" : "DISABLED"

  schedule_expression          = var.schedule_expression
  schedule_expression_timezone = var.schedule_timezone

  # OFF, not a window, and now for a sharper reason than before. A job's slot is
  # an instant computed from its own cron, and a tick that drifted could pick up
  # a slot the previous tick should have taken — spending an hour's latency on
  # a briefing for no benefit. Fixed ticks also keep "did the tick happen?"
  # answerable by looking at one moment rather than a range.
  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.worker.arn
    role_arn = aws_iam_role.scheduler.arn

    # Zero, which is not the default, and load-bearing rather than merely
    # thrifty. Scheduler retries 185 times over 24 hours unless told otherwise,
    # and the claim is at-most-once by design: a retried tick would find the
    # slot already taken and skip it, so every retry is a wasted invocation, and
    # a retry that *did* land in a new hour would run the next slot early. A
    # failed tick waits for the next hour.
    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}
