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
  function_name            = "briefing-worker"
  lambda_zip_path          = "./tests/fixtures/lambda.zip"
  alerts_topic_arn         = "arn:aws:sns:ap-southeast-2:000000000000:briefing-worker-alerts"
  user_storage_bucket_name = "control-panel-user-storage-test"
}

run "on_duty" {
  command = plan

  module {
    source = "./modules/briefing-worker"
  }

  # The schedule is a *tick*, not a briefing time. A job's own cadence lives in
  # `jobs.schedule_cron` in Postgres, and the worker asks what is due — so this
  # firing daily again would silently round every job's schedule to whatever
  # hour this names, and no job row would disagree with it.
  assert {
    condition     = aws_scheduler_schedule.daily.schedule_expression == "cron(0 * * * ? *)"
    error_message = "The schedule must be an hourly tick; a daily one silently caps every job's cadence at once a day."
  }

  # The contract the claim depends on: at most one invocation per tick. There
  # are two independent retry layers and turning off the obvious one only covers
  # half the problem — Scheduler invokes asynchronously, which brings Lambda's
  # own two retries in from a layer retry_policy cannot reach.
  assert {
    condition = alltrue([
      for target in aws_scheduler_schedule.daily.target :
      alltrue([for policy in target.retry_policy : policy.maximum_retry_attempts == 0])
    ])
    error_message = "Scheduler retries must be 0, or a failed tick is retried 185 times over 24 hours."
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

  # All three secrets are shells and stay shells. A version resource here would
  # put the value in plan output, in state, and in the apply log — which is the
  # one property this whole arrangement exists for, and a connection string
  # carries a password.
  assert {
    condition = alltrue([
      for secret in [
        aws_secretsmanager_secret.openai,
        aws_secretsmanager_secret.database,
        aws_secretsmanager_secret.apify,
      ] :
      secret.recovery_window_in_days == 7
    ])
    error_message = "Every secret must keep a recovery window; a mistaken destroy is otherwise unrecoverable."
  }

  # Not asserted here: that `read_secrets` names all three ARNs. Its `resources`
  # is a *set* of values a mocked provider does not know until apply, and a set
  # of unknowns has an unknown length — two of them could turn out to be the
  # same string. `length(...) == 3` is therefore unevaluatable at plan time,
  # unlike the single-element `logs` document above. The grant staying in step
  # with `local.environment` is covered by review and by the first cold start,
  # which fails loudly on a secret it may not read.

  # The worker cannot find out what is due without this. Asserted on the key
  # rather than on the ARN it holds, because a mocked provider does not know an
  # ARN until apply — and the failure worth catching here is the variable going
  # missing, not it carrying the wrong string.
  assert {
    condition     = contains(keys(local.environment), "DATABASE_SECRET_ID")
    error_message = "DATABASE_SECRET_ID must be set on the function, mirroring OPENAI_SECRET_ID."
  }

  # The secret's ARN, never its value. A connection string carries a password,
  # and an environment variable would put it in plan output, in state, and on
  # the console's function configuration page.
  assert {
    condition     = !contains(keys(local.environment), "DATABASE_URL")
    error_message = "The connection string must never be a Lambda environment variable — it would land in plan output and in state."
  }

  # Same arrangement for the search token, and the same reason.
  assert {
    condition     = contains(keys(local.environment), "APIFY_SECRET_ID")
    error_message = "APIFY_SECRET_ID must be set on the function, or the scout has no way to search."
  }

  assert {
    condition     = !contains(keys(local.environment), "APIFY_TOKEN")
    error_message = "The Apify token must never be a Lambda environment variable — it would land in plan output and in state."
  }

  # Not secrets, so these carry their values rather than an ARN. Without them
  # the store cannot be constructed at all, and every run fails at the upload
  # having already paid for the model and the searches.
  assert {
    condition     = local.environment["USER_STORAGE_BUCKET_NAME"] == var.user_storage_bucket_name
    error_message = "USER_STORAGE_BUCKET_NAME must carry the bucket the root wired in, or briefs are written somewhere nobody reads."
  }

  # The IAM attachment in briefing-worker.tf covers every environment's briefs
  # policy on purpose, so this value — not the grant — is what decides where the
  # worker actually writes.
  assert {
    condition     = local.environment["USER_STORAGE_ENVIRONMENT"] == "prod"
    error_message = "USER_STORAGE_ENVIRONMENT must be set; it is the first segment of every object key."
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
