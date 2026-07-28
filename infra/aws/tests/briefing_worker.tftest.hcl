# Plan-level assertions for the briefing-worker stack. Mocked provider, so this
# runs on a pull request with no credentials. See the scope note in
# user_storage.tftest.hcl for what is deliberately not asserted here.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  function_name    = "briefing-worker"
  lambda_zip_path  = "./tests/fixtures/lambda.zip"
  alerts_topic_arn = "arn:aws:sns:ap-southeast-2:000000000000:briefing-worker-alerts"
}

run "on_duty" {
  command = plan

  module {
    source = "./modules/briefing-worker"
  }

  # The contract the daily check depends on: exactly one `proof-run` line per
  # slot. There are two independent retry layers and turning off the obvious one
  # only covers half the problem — Scheduler invokes asynchronously, which
  # brings Lambda's own two retries in from a layer retry_policy cannot reach.
  # Either one left at its default re-bills a failing LLM run all day.
  assert {
    condition = alltrue([
      for target in aws_scheduler_schedule.daily.target :
      alltrue([for policy in target.retry_policy : policy.maximum_retry_attempts == 0])
    ])
    error_message = "Scheduler retries must be 0, or a failed run is retried 185 times over 24 hours."
  }

  assert {
    condition     = aws_lambda_function_event_invoke_config.worker.maximum_retry_attempts == 0
    error_message = "Lambda async retries must be 0; retry_policy on the schedule does not cover this layer."
  }

  assert {
    condition     = aws_scheduler_schedule.daily.state == "ENABLED"
    error_message = "schedule_enabled = true must produce an ENABLED schedule."
  }

  # A fixed moment, not a window, so 'did today's run happen?' is answerable by
  # looking at one time rather than a range.
  assert {
    condition = alltrue([
      for window in aws_scheduler_schedule.daily.flexible_time_window :
      window.mode == "OFF"
    ])
    error_message = "The flexible time window must be OFF."
  }

  # Both alarms exist while the worker is on duty, and both publish to the
  # root's shared topic rather than one the module made for itself.
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.not_invoked) == 1
    error_message = "The missed-run alarm must exist while the schedule is enabled — it is the only one that catches silence."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.errors.alarm_actions == toset([var.alerts_topic_arn])
    error_message = "Alarms must publish to the root's shared topic."
  }

  # Breaching, not notBreaching. No datapoint here means no invocation, which is
  # precisely the condition being watched for.
  assert {
    condition     = aws_cloudwatch_metric_alarm.not_invoked[0].treat_missing_data == "breaching"
    error_message = "The missed-run alarm must treat missing data as breaching, or silence reads as health."
  }

  # The usual shortcut is AWSLambdaBasicExecutionRole, which grants logs:* on
  # `*` — the worker could write into any log group in the account.
  assert {
    condition     = length(data.aws_iam_policy_document.logs.statement[0].resources) == 1
    error_message = "Log write access must be scoped to the worker's own group, not granted account-wide."
  }
}

run "off_duty" {
  command = plan

  module {
    source = "./modules/briefing-worker"
  }

  variables {
    schedule_enabled = false
  }

  assert {
    condition     = aws_scheduler_schedule.daily.state == "DISABLED"
    error_message = "schedule_enabled = false must produce a DISABLED schedule."
  }

  # The function stays deployed and manually invocable — that is the safe half
  # of a cutover, and what DEPLOYING.md tells you to do before putting a change
  # on duty.
  assert {
    condition     = aws_lambda_function.worker.function_name == var.function_name
    error_message = "Disabling the schedule must not remove the function."
  }

  # Gated, because treat_missing_data = "breaching" would otherwise hold this
  # alarm permanently in ALARM while the worker is deliberately off duty — and
  # an alarm that is always red is one people learn to ignore.
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.not_invoked) == 0
    error_message = "The missed-run alarm must not exist while the schedule is off, or it fires forever and trains everyone to ignore it."
  }
}
