# ---------------------------------------------------------------------------
# The dashboard's AWS access
# ---------------------------------------------------------------------------
#
# The Next.js app on Vercel writes and reads the documents a user uploads. It
# gets there the same way CI does — a short-lived OIDC token exchanged for
# temporary credentials — so there is no access key on the Vercel side either,
# and nothing to rotate.
#
# Two halves in two roots. The **provider** is created by `bootstrap/`, because
# `bootstrap/deploy-iam.tf` deliberately grants nothing that can create one; the
# **role** is here, because `control-panel-vercel-dashboard` matches
# `managed_role_arn_patterns` and so is within what CI may create. The seam
# between them is a URL, looked up rather than read out of bootstrap's state —
# that state is a local file on one laptop, the same argument `boundary.tf`
# makes for resolving the permissions boundary by name.
#
# The whole stack is gated on `var.vercel_dashboard` being non-null. See that
# variable for why the default creates nothing.

locals {
  vercel_dashboard_enabled = var.vercel_dashboard != null

  # `try` throughout, and an empty string rather than null as the fallback.
  #
  # Locals are evaluated whether or not anything consumes them, so these are
  # computed even when the gate above is false and no resource reads them. A
  # null would then fail the string interpolations below with "cannot include a
  # null value in a string template" — the whole plan, not just this stack. The
  # empty string produces derived values that are meaningless and never used,
  # which is the correct outcome for a stack that creates nothing.
  vercel_team_slug    = try(var.vercel_dashboard.team_slug, "")
  vercel_project_name = try(var.vercel_dashboard.project_name, "")
  vercel_environments = try(var.vercel_dashboard.environments, ["production"])

  vercel_issuer_url = coalesce(
    try(var.vercel_dashboard.issuer_url, null),
    "https://oidc.vercel.com/${local.vercel_team_slug}"
  )

  vercel_audience = coalesce(
    try(var.vercel_dashboard.audience, null),
    "https://vercel.com/${local.vercel_team_slug}"
  )

  # IAM condition keys name the issuer without its scheme —
  # `token.actions.githubusercontent.com:sub` in oidc.tf, and the same rule
  # applies to an issuer carrying a path.
  vercel_issuer_host = replace(local.vercel_issuer_url, "https://", "")

  # Team issuer mode's subject shape. Global mode builds the same three pairs
  # out of opaque ids instead of slugs, which is what the `subjects` override is
  # for — see the variable.
  vercel_subjects = coalesce(
    try(var.vercel_dashboard.subjects, null),
    [
      for environment in local.vercel_environments :
      "owner:${local.vercel_team_slug}:project:${local.vercel_project_name}:environment:${environment}"
    ]
  )
}

data "aws_iam_openid_connect_provider" "vercel" {
  count = local.vercel_dashboard_enabled ? 1 : 0

  url = local.vercel_issuer_url
}

# The whole security boundary of this role is in this document.
data "aws_iam_policy_document" "vercel_dashboard_trust" {
  count = local.vercel_dashboard_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.vercel[0].arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.vercel_issuer_host}:aud"
      values   = [local.vercel_audience]
    }

    # `StringEquals`, and all three of owner, project and environment pinned.
    #
    # This is the difference between "the dashboard may read user documents" and
    # "anything this issuer signs a token for may read user documents" — and the
    # issuer signs one for every project in the team and every deployment of
    # each. A throwaway project created under the same team would otherwise
    # assume this role and read every user's uploads.
    #
    # Note the contrast with the GitHub trust in `bootstrap/oidc.tf`, which uses
    # StringLike. That is a concession to GitHub's subject claim not being
    # knowable before the first run, not a house style. Here the shape is known
    # up front, so there is nothing to loosen for.
    condition {
      test     = "StringEquals"
      variable = "${local.vercel_issuer_host}:sub"
      values   = local.vercel_subjects
    }
  }
}

resource "aws_iam_role" "vercel_dashboard" {
  count = local.vercel_dashboard_enabled ? 1 : 0

  name               = "control-panel-vercel-dashboard"
  description        = "Assumed by the Next.js dashboard on Vercel to read and write user documents."
  assume_role_policy = data.aws_iam_policy_document.vercel_dashboard_trust[0].json

  # Not optional. `bootstrap/deploy-iam.tf` conditions `iam:CreateRole` on this
  # exact ARN, so a role declared without it fails to apply from CI with an
  # access-denied that names the role rather than the missing boundary.
  permissions_boundary = data.aws_iam_policy.workload_boundary.arn

  tags = {
    Component = "vercel-dashboard"
  }
}

# Take the **narrow** grant — the same reasoning as `briefing-worker.tf`, in the
# other direction. The dashboard handles documents a user uploaded, so it wants
# `prod:resumes` and not the per-environment policy that would also let it
# rewrite the briefs the worker generates.
#
# The two attachments are disjoint by construction, and that disjointness is
# asserted in `tests/vercel_dashboard.tftest.hcl`: the worker cannot delete
# someone's CV, and the dashboard cannot forge a briefing. Neither property is
# obvious from either file alone, which is why it is a check rather than a
# comment.
#
# This policy already existed and was attached to nothing — the user-storage
# module has published it since the bucket was created. Nothing new is authored
# here; it is only pointed at a principal for the first time.
resource "aws_iam_role_policy_attachment" "vercel_dashboard_user_storage" {
  for_each = local.vercel_dashboard_enabled ? {
    for key, arn in module.user_storage.kind_access_policy_arns :
    key => arn if endswith(key, ":resumes")
  } : {}

  role       = aws_iam_role.vercel_dashboard[0].name
  policy_arn = each.value
}
