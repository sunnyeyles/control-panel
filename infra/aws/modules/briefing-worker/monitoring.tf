# Alerting the Azure deployment did not have.
#
# There it was an explicit decision to go without ("no automatic retry and no
# alerting, by decision"), which was defensible while someone was watching the
# thing get built. It stops being defensible once the worker is the only thing
# producing a daily artifact: with retries off, a failure is a silent gap.

resource "aws_sns_topic" "alerts" {
  name = "${var.function_name}-alerts"

  tags = var.tags
}

# Requires a click in the confirmation mail AWS sends. Until that happens the
# subscription sits in `PendingConfirmation` and delivers nothing, which is
# worth knowing before treating silence as good news.
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

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

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = var.tags
}

# The failure mode an error alarm cannot see: the run never started. A deleted
# schedule, a broken scheduler role or a disabled rule all look like silence,
# and silence is indistinguishable from success unless something asserts that
# an invocation should have happened.
#
# This is the direct equivalent of the KQL check the Azure setup relied on a
# human to run — "one success row per slot, and a missing row means it never
# started" — moved from a person's memory into an alarm.
resource "aws_cloudwatch_metric_alarm" "not_invoked" {
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

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = var.tags
}
