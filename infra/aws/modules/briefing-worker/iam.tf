# The execution role. Two inline policies rather than one merged document, so
# granting the worker something new is a new resource in a diff rather than an
# edit inside a shared block that is hard to review.

data "aws_iam_policy_document" "execution_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name                 = "${var.function_name}-execution"
  description          = "Execution role for the briefing worker Lambda."
  assume_role_policy   = data.aws_iam_policy_document.execution_trust.json
  permissions_boundary = var.permissions_boundary_arn

  tags = var.tags
}

# Deliberately not AWSLambdaBasicExecutionRole, which is the usual shortcut:
# that managed policy grants logs:* against `*`, so the worker could write into
# any log group in the account. Scoped to its own group instead.
#
# CreateLogGroup is also absent. Terraform owns the group, so the function has
# no reason to be able to make one — and if it ever needs to, that is the
# symptom of the race main.tf's depends_on exists to prevent.
data "aws_iam_policy_document" "logs" {
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.worker.arn}:*"]
  }
}

resource "aws_iam_role_policy" "logs" {
  name   = "logs"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.logs.json
}

# One secret, by ARN. The worker reads the OpenAI key and nothing else.
data "aws_iam_policy_document" "read_openai_secret" {
  statement {
    sid       = "ReadOpenAIKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.openai.arn]
  }
}

resource "aws_iam_role_policy" "read_openai_secret" {
  name   = "read-openai-secret"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_openai_secret.json
}

# The scheduler's own role. EventBridge Scheduler assumes a role to call its
# target, rather than the target carrying a resource-based policy naming the
# caller. That is why there is no aws_lambda_permission anywhere in this
# module: permission to invoke lives in exactly one place.
data "aws_iam_policy_document" "scheduler_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    # The confused-deputy guard. Without it the trust policy would let the
    # scheduler service assume this role on behalf of any AWS account that
    # named it, not just ours.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name                 = "${var.function_name}-scheduler"
  description          = "Assumed by EventBridge Scheduler to invoke the briefing worker."
  assume_role_policy   = data.aws_iam_policy_document.scheduler_trust.json
  permissions_boundary = var.permissions_boundary_arn

  tags = var.tags
}

data "aws_iam_policy_document" "scheduler_invoke" {
  statement {
    sid       = "InvokeBriefingWorker"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.worker.arn]
  }
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  name   = "invoke-worker"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler_invoke.json
}
