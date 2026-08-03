data "aws_caller_identity" "current" {}

locals {
  # Every environment variable the function gets, in one place. Adding one is a
  # line here rather than an edit inside the resource block, which keeps the
  # diff of "the worker learned about a new thing" small and obvious.
  #
  # OPENAI_API_KEY, DATABASE_URL, APIFY_TOKEN and the Langfuse keys are
  # deliberately absent: all values are fetched from Secrets Manager at cold
  # start. Putting any of
  # them here would place a secret in plan output, in state, and in the
  # console's function configuration page.
  #
  # The two USER_STORAGE_ variables are not secrets and so are passed directly.
  # They are what `createS3UserObjectStore()` reads; AWS_REGION needs no entry
  # because the Lambda runtime sets it, which keeps the region the function runs
  # in and the region it writes to from being two facts that can disagree.
  environment = {
    OPENAI_SECRET_ID              = aws_secretsmanager_secret.openai.arn
    DATABASE_SECRET_ID            = aws_secretsmanager_secret.database.arn
    APIFY_SECRET_ID               = aws_secretsmanager_secret.apify.arn
    LANGFUSE_PUBLIC_KEY_SECRET_ID = aws_secretsmanager_secret.langfuse_public.arn
    LANGFUSE_SECRET_KEY_SECRET_ID = aws_secretsmanager_secret.langfuse_secret.arn

    LANGCHAIN_CALLBACKS_BACKGROUND = "false"
    LANGFUSE_BASE_URL              = var.langfuse_base_url
    LANGFUSE_TRACING_ENVIRONMENT   = var.langfuse_tracing_environment
    USER_STORAGE_BUCKET_NAME       = var.user_storage_bucket_name
    USER_STORAGE_ENVIRONMENT       = var.user_storage_environment
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
