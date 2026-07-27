data "aws_caller_identity" "current" {}

locals {
  # Both shapes of GitHub's subject claim for the main branch: the historical
  # `repo:owner/name:ref:...` and the post-2026-07-15 immutable form carrying
  # numeric IDs. See the variable's documentation for why guessing is not an
  # option and where to read the real value.
  default_subject_patterns = [
    "repo:${var.github_owner}/${var.github_repo}:ref:refs/heads/main",
    "repo:${var.github_owner}@*/${var.github_repo}@*:ref:refs/heads/main",
  ]

  subject_patterns = coalesce(var.github_subject_patterns, local.default_subject_patterns)
}

# ---------------------------------------------------------------------------
# Terraform state
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket_name

  # State is the one thing here whose loss is not recoverable by re-running
  # anything, so deleting this bucket should take an edit to this file.
  lifecycle {
    prevent_destroy = true
  }
}

# The undo button for state. A corrupted or truncated state file is recoverable
# by rolling back to the previous version; without this it is recoverable by
# hand-importing every resource.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# State holds every resource attribute Terraform has ever read, which for some
# providers includes generated credentials. Public access is blocked at the
# bucket level rather than trusted to object ACLs.
resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------------------------------------------------------------------
# GitHub OIDC
# ---------------------------------------------------------------------------

# No long-lived access key exists anywhere in this project. GitHub mints a
# short-lived token per run and AWS exchanges it for temporary credentials —
# the same arrangement the Azure federated credential provided, so nothing is
# lost in the port.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # Empty on purpose. AWS validates this provider's certificate against its own
  # trust store rather than a pinned thumbprint, so a hardcoded fingerprint here
  # would be a value that expires, breaks every deploy on the day it rotates,
  # and is copied from a blog post rather than verified.
  #
  # If an apply ever rejects the empty list, fetch the real one rather than
  # pasting a remembered value:
  #   openssl s_client -servername token.actions.githubusercontent.com \
  #     -showcerts -connect token.actions.githubusercontent.com:443
  thumbprint_list = []
}

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # StringLike rather than StringEquals, and only because the exact subject
    # is not knowable ahead of the first run. Tighten to StringEquals with the
    # observed value once CloudTrail has shown it.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.subject_patterns
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "control-panel-deploy"
  description        = "Assumed by GitHub Actions to run terraform apply."
  assume_role_policy = data.aws_iam_policy_document.deploy_trust.json
}

data "aws_iam_policy_document" "deploy" {
  # Terraform's own state.
  statement {
    sid       = "TerraformState"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.state.arn]
  }

  statement {
    sid       = "TerraformStateObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/*"]
  }

  # The services the two stacks are made of. Deliberately coarse: a genuinely
  # least-privilege Terraform deployer is discovered by collecting apply
  # failures, and a half-guessed one fails in production rather than here. The
  # boundary that is *not* coarse is the explicit deny below.
  statement {
    sid = "ManageStacks"
    actions = [
      "lambda:*",
      "scheduler:*",
      "logs:*",
      "cloudwatch:*",
      "sns:*",
      "s3:*",
    ]
    resources = ["*"]
  }

  # Roles and policies for both stacks. iam:* is not granted — creating users,
  # access keys or account-level settings is not something a deploy needs.
  statement {
    sid = "ManageRolesAndPolicies"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:ListRoleTags",
      "iam:PassRole",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:CreatePolicy",
      "iam:DeletePolicy",
      "iam:GetPolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
      "iam:TagPolicy",
      "iam:UntagPolicy",
      "iam:ListPolicyTags",
    ]
    resources = ["*"]
  }

  # The secret shell, but never its contents. Creating, tagging and destroying
  # the container is deployment; reading what is in it is not.
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
    ]
    resources = ["*"]
  }

  # The single most important statement in this file.
  #
  # Azure achieved this by gating the Key Vault Secrets Officer assignment on
  # `principalType == 'User'`, so the pipeline could provision the vault and
  # never read the key. This is that property translated: an explicit Deny
  # overrides every Allow, including any added later by someone widening the
  # statements above, so the pipeline cannot read or set the OpenAI key no
  # matter how the rest of this policy drifts.
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

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
