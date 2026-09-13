# One alerting destination for the whole root.
#
# Alerting belongs to the deployment, not to any one stack, so the topic is here
# and a stack that raises alarms is handed its ARN. Nothing publishes to it
# today — the only stack that did was removed along with the job search — but
# the topic and its confirmed subscription are kept, because standing them back
# up costs a confirmation mail and a window in which alarms go nowhere.

resource "aws_sns_topic" "alerts" {
  # `briefing-worker-alerts` rather than `control-panel-alerts`, which is the
  # name this would have if it were being created today. The worker it was
  # named for is gone; the name stays.
  #
  # ⚠️ `name` forces replacement, and replacing this topic replaces the
  # subscription hanging off it. A tidier name costs a confirmation mail and a
  # window of undelivered alarms.
  name = "briefing-worker-alerts"

  tags = {
    Component = "alerting"
  }
}

# ⚠️ Requires a click in the confirmation mail AWS sends; until then it sits in
# `PendingConfirmation` and delivers nothing. A destroy-and-recreate therefore
# silently disarms alerting, and silence that looks like health is the exact
# failure alarms exist to catch.
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

output "alerts_topic_arn" {
  description = "The one SNS topic any stack's alarms publish to. Check the email subscription is Confirmed, not PendingConfirmation, before treating quiet as good news."
  value       = aws_sns_topic.alerts.arn
}
