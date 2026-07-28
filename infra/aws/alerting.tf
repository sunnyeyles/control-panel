# One alerting destination for the whole root.
#
# This lived inside the briefing-worker module until it became clear what the
# second stack would have to do: create its own topic, and its own email
# subscription, and send its own confirmation mail to the same person. Alerting
# is a property of the deployment, not of any one stack — so the topic is here
# and stacks are handed its ARN.
#
# A stack that wants a different destination gets its own topic. That is a real
# requirement when it appears; until then, one.

resource "aws_sns_topic" "alerts" {
  # `briefing-worker-alerts` rather than `control-panel-alerts`, which is the
  # name this would have if it were being created today.
  #
  # `name` forces replacement, and replacing this topic replaces the
  # subscription hanging off it — the one thing the `moved` blocks below exist
  # to prevent. A tidier name costs a confirmation mail and a window of
  # undelivered alarms, which is not a trade worth making for a string. Rename
  # it the next time the subscription has to be recreated for some other reason.
  name = "briefing-worker-alerts"

  tags = {
    Component = "alerting"
  }
}

# Requires a click in the confirmation mail AWS sends. Until that happens the
# subscription sits in `PendingConfirmation` and delivers nothing, which is
# worth knowing before treating silence as good news.
#
# It is also why the `moved` blocks below matter: a destroy-and-recreate of this
# resource sends a fresh confirmation mail and delivers nothing until someone
# clicks it. Silence that looks like health is the exact failure the alarms
# exist to catch.
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Relocation, not replacement. Both resources already exist inside
# module.briefing_worker; without these Terraform reads the new addresses as new
# resources, destroys the old ones, and disarms alerting until the new
# confirmation mail is clicked.
#
# Safe to delete once an apply has run with them in place — but there is no cost
# to leaving them, and deleting them early is how the migration gets repeated
# for anyone who has not applied yet.
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
