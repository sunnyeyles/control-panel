# Alerting, because with retries off a failure is a silent gap.
#
# Going without is defensible while someone is watching the thing get built. It
# stops being defensible once the worker is the only thing producing a daily
# artifact and nobody is looking at it on purpose.
#
# The topic and its subscription are not here: they belong to the root, which
# owns one topic for every stack. A per-stack topic means a per-stack
# confirmation mail, and the fourth stack means a fourth one for the same human.
# This module states which alarms exist; where they are delivered is not its
# business.

# A run that ran and threw. `runScheduledTask` rethrows after emitting its
# failure report, and the handler catches nothing, so any bad run lands here.
resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name        = "${var.function_name}-errors"
  alarm_description = "The briefing worker failed. Check the proof-run line with outcome=failure for the reason."

  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  dimensions  = { FunctionName = aws_lambda_function.worker.function_name }

  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"

  # A day with no invocation at all produces no datapoint. That is not a
  # failure of this alarm — it is what the missed-run alarm below is for.
  treat_missing_data = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  tags = var.tags
}

# The failure mode an error alarm cannot see: the run never started. A deleted
# schedule, a broken scheduler role or a disabled rule all look like silence,
# and silence is indistinguishable from success unless something asserts that
# an invocation should have happened.
#
# The assertion is "one invocation per slot, and a missing one means it never
# started" — the check a human would otherwise have to remember to run against
# the logs, moved into an alarm.
#
# Gated on the schedule, because `treat_missing_data = "breaching"` means a
# disabled schedule puts this alarm permanently in ALARM. An alarm that is
# always red while the worker is deliberately off duty is an alarm people learn
# to ignore — and it is the only one that catches silence, so that is precisely
# the habit not to teach.
resource "aws_cloudwatch_metric_alarm" "not_invoked" {
  count = var.schedule_enabled ? 1 : 0

  alarm_name        = "${var.function_name}-not-invoked"
  alarm_description = "The briefing worker did not run in the last 24 hours. The schedule, not the code, is the thing to check."

  namespace   = "AWS/Lambda"
  metric_name = "Invocations"
  dimensions  = { FunctionName = aws_lambda_function.worker.function_name }

  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"

  # Breaching, unlike the alarm above. No datapoint here means no invocation,
  # which is precisely the condition being watched for.
  treat_missing_data = "breaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  tags = var.tags
}
