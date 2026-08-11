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
# The assertion is "at least one invocation a day, and none at all means the
# schedule is broken". Deliberately unchanged when the cadence became hourly:
# tightening the period to match would catch a dead scheduler roughly a day
# sooner and would also fire on any single Neon wake that outlasts one hour, and
# an alarm that cries wolf is worse than one that is slow. Twenty-four missed
# ticks in a row is not a subtle condition.
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
