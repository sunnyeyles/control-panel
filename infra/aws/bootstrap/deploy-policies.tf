# What the deploy role can do, as five attached managed policies rather than one
# inline blob.
#
# The split is for growth, not tidiness. An inline role policy is capped at
# 10,240 characters and every service a new stack introduces enlarges the same
# document; a managed policy per domain means a new stack adds a file, and the
# review question becomes "should the pipeline be able to do this?" rather than
# "what changed in this 200-line JSON diff?".
#
# The property that makes splitting safe is worth stating: an explicit `Deny` in
# any attached policy overrides an `Allow` in every other one. So the two Denies
# below — never read a secret's value, never remove a permissions boundary —
# hold across the whole set and cannot be undone by widening a different file.
#
# Deliberately coarse where it is coarse. A genuinely least-privilege Terraform
# deployer is discovered by collecting apply failures rather than predicted, and
# a half-guessed one fails during a deployment instead of here. The parts that
# are *not* coarse are the IAM conditions in deploy-iam.tf and the two Denies.

locals {
  deploy_policies = {
    state   = data.aws_iam_policy_document.deploy_state.json
    compute = data.aws_iam_policy_document.deploy_compute.json
    storage = data.aws_iam_policy_document.deploy_storage.json
    iam     = data.aws_iam_policy_document.deploy_iam.json
    secrets = data.aws_iam_policy_document.deploy_secrets.json
  }
}

resource "aws_iam_policy" "deploy" {
  for_each = local.deploy_policies

  name        = "control-panel-deploy-${each.key}"
  description = "Deploy role permissions: ${each.key}."
  policy      = each.value
}

resource "aws_iam_role_policy_attachment" "deploy" {
  for_each = aws_iam_policy.deploy

  role       = aws_iam_role.deploy.name
  policy_arn = each.value.arn
}

# ---------------------------------------------------------------------------
# state — Terraform's own bookkeeping
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "deploy_state" {
  statement {
    sid       = "TerraformStateBucket"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.state.arn]
  }

  # DeleteObject covers the lock file `use_lockfile` writes beside the state, not
  # just the state itself.
  statement {
    sid       = "TerraformStateObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/*"]
  }
}

# ---------------------------------------------------------------------------
# compute — the services the stacks are built from
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "deploy_compute" {
  statement {
    sid = "ManageCompute"
    actions = [
      "lambda:*",
      "scheduler:*",
      "logs:*",
      "cloudwatch:*",
      "sns:*",
    ]
    resources = ["*"]
  }
}

# ---------------------------------------------------------------------------
# storage — buckets the stacks own
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "deploy_storage" {
  statement {
    sid       = "ManageBuckets"
    actions   = ["s3:*"]
    resources = ["*"]
  }
}

# ---------------------------------------------------------------------------
# secrets — the shell, never the contents
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "deploy_secrets" {
  # Creating, tagging and destroying the container is deployment; reading what
  # is in it is not.
  statement {
    sid = "ManageSecretShell"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:UpdateSecret",
      "secretsmanager:RestoreSecret",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
      "secretsmanager:ListSecretVersionIds",

      # Read *after* create, not a widening of what CI may read. The provider
      # refreshes an `aws_secretsmanager_secret` by calling DescribeSecret and
      # GetResourcePolicy, so without this the secret is created and the apply
      # then fails reading back the resource it just made — which is how this
      # was found.
      #
      # Note which "policy" this is: the resource policy says *who may reach the
      # secret*, and is null here because nothing attaches one. It is not the
      # secret's value. Reading the value is `GetSecretValue`, which the Deny
      # below still refuses.
      "secretsmanager:GetResourcePolicy",
    ]
    resources = ["*"]
  }

  # The single most important statement in this directory.
  #
  # The pipeline provisions the secret and can never read it. An explicit Deny
  # overrides every Allow — including any added later by widening a different
  # one of these five policies — so the pipeline cannot read or set the OpenAI
  # key no matter how the rest of them drift.
  #
  # The consequence is intended: adding an `aws_secretsmanager_secret_version`
  # resource will fail in CI. That is the guardrail working, not a bug — the
  # value is set by a human, once, out of band.
  statement {
    sid    = "NeverReadOrWriteSecretValues"
    effect = "Deny"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
    ]
    resources = [var.deployed_secret_arn_pattern]
  }
}
