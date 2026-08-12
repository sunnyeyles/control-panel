# The dashboard's AWS access.
#
# The Next.js app on Vercel reads and writes the documents a user uploads, via a
# short-lived OIDC token exchanged for temporary credentials — so there is no
# access key on the Vercel side and nothing to rotate.
#
# Two halves in two roots. The **provider** is created by `bootstrap/`, because
# `bootstrap/deploy-iam.tf` grants nothing that can create one; the **role** is
# here, because `control-panel-vercel-dashboard` matches
# `managed_role_arn_patterns`. The seam is a URL, looked up rather than read out
# of bootstrap's state — that state is a local file on one laptop.
#
# The stack is gated on `var.vercel_dashboard` being non-null; see that variable.

locals {
  vercel_dashboard_enabled = var.vercel_dashboard != null

  # ⚠️ `try` throughout, with an empty string rather than null as the fallback.
  # Locals are evaluated whether or not anything consumes them, so a null here
  # fails the interpolations below with "cannot include a null value in a string
  # template" — failing the whole plan, not just this stack.
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
    # The issuer signs a token for every project in the team, so this is the
    # difference between "the dashboard may read user documents" and "anything
    # this issuer signs for may". A throwaway project under the same team would
    # otherwise assume this role.
    #
    # `bootstrap/oidc.tf` uses StringLike as a concession to GitHub's subject
    # claim not being knowable before the first run, not as house style — here
    # the shape is known up front.
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

# Take the **narrow** grants — the same reasoning as `briefing-worker.tf`, in
# the other direction. The dashboard handles documents a user uploaded and the
# cover letters it drafts for them, so it wants `prod:resumes` and
# `prod:cover-letters` and not the per-environment policy that would also let it
# rewrite the briefs the worker generates.
#
# **Enumerated rather than pattern-matched.** The filter used to be
# `endswith(key, ":resumes")`; a suffix list keeps that shape while sitting one
# careless `or` away from covering briefs.
#
# The two roles' attachments are disjoint by construction — the worker cannot
# delete someone's CV, the dashboard cannot forge a briefing — and that is
# asserted in `tests/vercel_dashboard.tftest.hcl`, because it is not obvious
# from either file alone. Nothing new is authored here; the user-storage module
# publishes each policy as soon as the kind is in `object_kinds`.
locals {
  # ⚠️ `briefs` is deliberately absent: the app holds no grant over what the
  # worker wrote, which is why /jobs renders the Findings on the run row rather
  # than the Brief itself. `tailored-resumes` is here for the `cover-letters`
  # reason — the app generates it from a button on a page, never on a schedule,
  # so the worker has no business with it and the sets stay disjoint.
  vercel_dashboard_kinds = ["resumes", "cover-letters", "tailored-resumes"]
}

resource "aws_iam_role_policy_attachment" "vercel_dashboard_user_storage" {
  for_each = local.vercel_dashboard_enabled ? {
    for key, arn in module.user_storage.kind_access_policy_arns :
    key => arn if contains(local.vercel_dashboard_kinds, element(split(":", key), 1))
  } : {}

  role       = aws_iam_role.vercel_dashboard[0].name
  policy_arn = each.value
}

# Asking the worker to run a briefing now.
#
# The "Run now" button does not run a briefing; it asks the worker to, with an
# async invocation naming a `runs` row it already inserted.
#
# **This does not widen the storage boundary above**, which is the whole reason
# the button works this way: the app that *renders* a briefing still holds no
# `prod:briefs` grant, so it can start work but never produce or alter its
# output. `tests/vercel_dashboard.tftest.hcl` asserts both halves — storage set
# unchanged, and this grant naming one function rather than `*`.
#
# **Inline** rather than a managed policy: nothing else can want a grant naming
# one function in one account, and a managed one would land in the `for_each`
# map the storage assertion checks by exact key set.
#
# No boundary change needed — `bootstrap/boundary.tf` already permits
# `lambda:InvokeFunction` on `*` for the scheduler role, and a boundary is a
# ceiling that may be wider than any one role's policy.
data "aws_iam_policy_document" "vercel_dashboard_invoke_worker" {
  count = local.vercel_dashboard_enabled ? 1 : 0

  statement {
    sid       = "InvokeBriefingWorker"
    actions   = ["lambda:InvokeFunction"]
    resources = [module.briefing_worker.function_arn]
  }
}

resource "aws_iam_role_policy" "vercel_dashboard_invoke_worker" {
  count = local.vercel_dashboard_enabled ? 1 : 0

  name   = "invoke-briefing-worker"
  role   = aws_iam_role.vercel_dashboard[0].id
  policy = data.aws_iam_policy_document.vercel_dashboard_invoke_worker[0].json
}
