# The ceiling on every role CI creates.
#
# ⚠️ The deploy role holds `iam:CreateRole`, `iam:AttachRolePolicy` and
# `iam:PassRole` — each individually reasonable, and together full administrator:
# create a role, attach `AdministratorAccess`, pass it to a Lambda, invoke it.
# Anything that can push to `main` could do that, and no care in `deploy-*.tf`
# prevents it.
#
# A boundary caps a role *regardless of what is attached to it* — effective
# permissions are the intersection — so `AdministratorAccess` on a role bounded
# by this grants exactly what is below. `deploy-iam.tf` conditions role creation
# on the boundary being set, which makes the cap unavoidable rather than merely
# available.
#
# What belongs here is the union of what every *workload* role needs; a ceiling
# may be wider than any individual role's policy. Nothing in the `iam:`
# namespace may ever appear — it is denied outright at the bottom.
data "aws_iam_policy_document" "workload_boundary" {
  # Writing logs. `CreateLogGroup` is included even though Terraform owns the
  # groups: a boundary that forbids it turns the log-group race described in
  # modules/briefing-worker/main.tf from "wrong retention" into "the function
  # cannot start".
  statement {
    sid = "WriteLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }

  # Reading a secret's value — the capability the deploy role itself is
  # explicitly denied. Provisioning a secret and reading one are different jobs,
  # and the workload has the second.
  statement {
    sid       = "ReadSecretValues"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["*"]
  }

  # Object-level S3 and the KMS verbs that go with an encrypted bucket. Bucket
  # administration is absent: a workload reads and writes objects, it does not
  # reconfigure the bucket it writes them to.
  statement {
    sid = "ReadWriteObjects"
    actions = [
      "s3:GetObject",
      "s3:GetObjectTagging",
      "s3:PutObject",
      "s3:PutObjectTagging",
      "s3:DeleteObject",
      "s3:ListBucket",
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]
    resources = ["*"]
  }

  # The scheduler role's whole job.
  statement {
    sid       = "InvokeFunctions"
    actions   = ["lambda:InvokeFunction"]
    resources = ["*"]
  }

  # The statement that makes this a boundary rather than a suggestion.
  #
  # Without it, a role created by CI could be given IAM permissions and used to
  # create a second, unbounded role — the escalation path reappearing one hop
  # further out. An explicit Deny in a boundary cannot be overridden by any
  # policy attached to the bounded role.
  #
  # No workload in this repository needs IAM. If one ever does, it needs its own
  # boundary, not a hole in this one.
  statement {
    sid       = "NeverGrantIAM"
    effect    = "Deny"
    actions   = ["iam:*", "sts:AssumeRole"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "workload_boundary" {
  name        = var.workload_boundary_policy_name
  description = "Permissions boundary for every role the deploy role creates. Caps effective permissions regardless of what is attached."
  policy      = data.aws_iam_policy_document.workload_boundary.json
}
