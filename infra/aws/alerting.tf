# One alerting destination for the whole root.
#
# This lived inside the briefing-worker module until it was clear the second
# stack would need its own topic, its own subscription, and its own confirmation
# mail to the same person. Alerting belongs to the deployment, not to any one
# stack, so the topic is here and stacks are handed its ARN.

resource "aws_sns_topic" "alerts" {
  # `briefing-worker-alerts` rather than `control-panel-alerts`, which is the
  # name this would have if it were being created today.
  #
  # ⚠️ `name` forces replacement, and replacing this topic replaces the
  # subscription hanging off it — exactly what the `moved` blocks below prevent.
  # A tidier name costs a confirmation mail and a window of undelivered alarms.
  name = "briefing-worker-alerts"

  tags = {
    Component = "alerting"
  }
}

# ⚠️ Requires a click in the confirmation mail AWS sends; until then it sits in
# `PendingConfirmation` and delivers nothing. That is why the `moved` blocks
# below matter — a destroy-and-recreate silently disarms alerting, and silence
# that looks like health is the exact failure the alarms exist to catch.
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Relocation, not replacement. Both resources already exist inside
# module.briefing_worker; without these, Terraform reads the new addresses as new
# resources and disarms alerting until a fresh confirmation mail is clicked.
# Deleting them early repeats the migration for anyone who has not applied yet.
moved {
  from = module.briefing_worker.aws_sns_topic.alerts
  to   = aws_sns_topic.alerts
}

moved {
  from = module.briefing_worker.aws_sns_topic_subscription.alerts_email
  to   = aws_sns_topic_subscription.alerts_email
}

output "alerts_topic_arn" {
  description = "The one SNS topic every stack's alarms publish to. Check the email subscription is Confirmed, not PendingConfirmation, before treating quiet as good news."
  value       = aws_sns_topic.alerts.arn
}
