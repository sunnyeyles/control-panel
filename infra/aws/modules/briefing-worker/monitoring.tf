# Alerting, because with retries off a failure is a silent gap.
#
# The topic and its subscription belong to the root, which owns one for every
# stack — a per-stack topic means a per-stack confirmation mail to the same
# human. This module states which alarms exist; where they are delivered is not
# its business.

# A tick that ran and threw. `runTick` rethrows after emitting its tick report
# — and each failing job has already emitted its own run report — while the
# handler catches nothing, so any bad tick lands here.
#
# Period is one hour, not one day. A 24-hour window with threshold 1 is a latch:
# one failed tick keeps every subsequent window non-zero until a full day is
# clean, so the alarm cannot return to OK and cannot signal the next real
# failure. With an hourly period, a single clean tick clears it — and ad-hoc
# runs still return rather than throw, so they do not feed this metric.
resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name        = "${var.function_name}-errors"
  alarm_description = "The briefing worker failed. Check the tick line for counts, then the briefing-run line with outcome=failure for the reason."

  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  dimensions  = { FunctionName = aws_lambda_function.worker.function_name }

  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"

  # An hour with no invocation at all produces no datapoint. That is not a
  # failure of this alarm — it is what the missed-run alarm below is for.
  treat_missing_data = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  tags = var.tags
}

# The failure mode an error alarm cannot see: the tick never started. A deleted
# schedule, a broken scheduler role or a disabled rule all look like silence,
# and silence is indistinguishable from success unless something asserts that
# an invocation should have happened.
#
# The assertion is "at least one invocation a day". Deliberately left daily when
# the cadence became hourly: an hourly period would catch a dead scheduler a day
# sooner but also fire on any Neon wake outlasting an hour, and twenty-four
# missed ticks in a row is not a subtle condition.
#
# ⚠️ Gated on the schedule, because `treat_missing_data = "breaching"` puts this
# permanently in ALARM while the worker is deliberately off duty — and it is the
# only alarm that catches silence, so that is the habit not to teach.
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
