# ---------------------------------------------------------------------------
# GitHub OIDC, and the role CI assumes
# ---------------------------------------------------------------------------

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

# No long-lived access key exists anywhere in this project. GitHub mints a
# short-lived token per run and AWS exchanges it for temporary credentials, so
# there is no secret to leak, rotate, or forget to rotate.
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
