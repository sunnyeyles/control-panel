# The ceiling on every role CI creates.
#
# The problem this solves is specific. The deploy role holds `iam:CreateRole`,
# `iam:AttachRolePolicy` and `iam:PassRole`, because Terraform genuinely needs
# all three to build the stacks. Ungoverned, that composes into full
# administrator: create a role, attach `AdministratorAccess` to it, pass it to a
# Lambda, invoke the Lambda. Anything that can push to `main` can do that, and
# no amount of care in `deploy-*.tf` prevents it — the three grants are each
# individually reasonable and the escalation is in their combination.
#
# A permissions boundary caps what a role can do *regardless of what is attached
# to it*. The effective permissions of a bounded role are the intersection of its
# policies and this document, so `AdministratorAccess` on a role bounded by this
# grants exactly what is written below and nothing more.
#
# `deploy-iam.tf` then conditions role creation on this boundary being set, which
# is what makes the cap unavoidable rather than merely available.
#
# What belongs here: the union of what every *workload* role legitimately needs —
# not what any one of them needs. It is a ceiling, so it is allowed to be wider
# than any individual role's own policy. What must never appear here is anything
# in the `iam:` namespace, which is denied outright at the bottom.
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
