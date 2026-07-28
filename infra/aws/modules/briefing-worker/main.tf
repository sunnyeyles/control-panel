data "aws_caller_identity" "current" {}

locals {
  # Every environment variable the function gets, in one place. Adding one is a
  # line here rather than an edit inside the resource block, which keeps the
  # diff of "the worker learned about a new thing" small and obvious.
  #
  # OPENAI_API_KEY is deliberately absent: the value is fetched from Secrets
  # Manager at cold start. Putting it here would place the key in plan output,
  # in state, and in the console's function configuration page.
  environment = {
    OPENAI_SECRET_ID = aws_secretsmanager_secret.openai.arn
  }
}

# Declared before the function and depended on explicitly, because Lambda
# creates this group implicitly on first invocation if it does not exist. That
# implicitly-created group has no retention policy and is not managed here, so
# losing the race means logs kept forever under a resource Terraform will later
# try to create and fail on.
resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = var.log_retention_days

  tags = var.tags
}

resource "aws_lambda_function" "worker" {
  function_name = var.function_name
  description   = "Runs the daily briefing task. Invoked by EventBridge Scheduler; see schedule.tf."
  role          = aws_iam_role.execution.arn

  runtime = "nodejs22.x"
  # The bundle is pure JavaScript with no native dependencies, so there is
  # nothing that can fail to have an arm64 build.
  architectures = ["arm64"]
  # Resolved from dist/package.json's `"type": "module"`, which is what makes
  # the runtime load index.js as ESM and find the named export.
  handler = "index.handler"

  filename = var.lambda_zip_path
  # What makes a code change a diff. Without it Terraform compares only the
  # file name, so rebuilding the zip would never redeploy.
  source_code_hash = filebase64sha256(var.lambda_zip_path)

  memory_size = var.memory_size
  timeout     = var.timeout

  environment {
    variables = local.environment
  }

  tags = var.tags

  depends_on = [aws_cloudwatch_log_group.worker]
}

# Scheduler invokes Lambda asynchronously, which brings Lambda's own retry
# behaviour into play on top of the scheduler's — two invocations of a failed
# run by default, from a layer the schedule's retry_policy does not cover.
# Both are turned off; see the note in schedule.tf for why one run per slot is
# the contract.
resource "aws_lambda_function_event_invoke_config" "worker" {
  function_name          = aws_lambda_function.worker.function_name
  maximum_retry_attempts = 0
}
