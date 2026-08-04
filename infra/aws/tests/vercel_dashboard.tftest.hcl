# Plan-level assertions for the vercel-dashboard stack.
#
# Root-level runs, because this stack is root-level resources rather than a
# module — `alerting.tf` and `boundary.tf` are the same shape. That means every
# run configures the whole root, which is why the `variables` block below names
# the other two stacks as well; `terraform test` does not auto-load
# terraform.tfvars.
#
# Scope, same honesty as user_storage.tftest.hcl: `aws_iam_policy_document` is a
# data source and its `json` is mocked, so what the trust policy *renders* is
# not asserted here. What is asserted is everything the configuration derives on
# the way to it — the subjects, the issuer host, the boundary, and which
# policies get attached. The one thing no test in this repo can check is whether
# those subjects match what Vercel actually puts in a token; that needs a
# decoded `VERCEL_OIDC_TOKEN` and is called out in DEPLOYING.md.

mock_provider "aws" {
  # `override_during = plan` so the worker's ARN is known while these run
  # blocks plan. Without it the invoke policy's `resources` is unknown until
  # apply, and the assertion that it is not a wildcard — the one worth having —
  # cannot be evaluated at all.
  override_during = plan

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn = "arn:aws:lambda:ap-southeast-2:000000000000:function:briefing-worker"
    }
  }

  # `boundary.tf` resolves the permissions boundary by name, and the resulting
  # arn is ARN-validated at plan time when a role consumes it.
  mock_data "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::000000000000:policy/control-panel-deploy-boundary"
    }
  }

  # Same problem for the federated principal: a mocked arn is a random string,
  # and it lands in a policy document's `identifiers`.
  mock_data "aws_iam_openid_connect_provider" {
    defaults = {
      arn = "arn:aws:iam::000000000000:oidc-provider/oidc.vercel.com/acme"
    }
  }
}

variables {
  alert_email = "alerts@example.com"

  user_storage = {
    bucket_name = "control-panel-user-storage-test"
  }

  briefing_worker = {
    lambda_zip_path = "./tests/fixtures/lambda.zip"
  }

  vercel_dashboard = {
    team_slug = "acme"
  }
}

run "configured" {
  command = plan

  # `control-panel-*` is not cosmetic: `bootstrap/deploy-iam.tf` scopes every
  # IAM statement to `managed_role_arn_patterns`, so a role named outside that
  # set fails its first apply from CI with an access-denied naming the role and
  # not the pattern.
  assert {
    condition     = startswith(aws_iam_role.vercel_dashboard[0].name, "control-panel-")
    error_message = "The role name must match the deploy role's managed_role_arn_patterns, or CI cannot create it."
  }

  # `iam:CreateRole` is conditioned on this exact ARN. Without it the apply is
  # denied rather than producing an unbounded role, but the error names the role
  # rather than the omission.
  assert {
    condition     = aws_iam_role.vercel_dashboard[0].permissions_boundary == data.aws_iam_policy.workload_boundary.arn
    error_message = "The role must carry the workload permissions boundary; iam:CreateRole is conditioned on it."
  }

  # The narrow grants, and only them. The per-environment policy would also
  # cover briefs.
  #
  # `keys()` returns them sorted, so `cover-letters` leads. Asserting the exact
  # set rather than membership is the point: a third kind added to
  # `local.vercel_dashboard_kinds` has to be argued for here, in a test whose
  # error message says what widening it costs.
  assert {
    condition     = keys(aws_iam_role_policy_attachment.vercel_dashboard_user_storage) == ["prod:cover-letters", "prod:resumes"]
    error_message = "The dashboard must be attached to exactly the prod:cover-letters and prod:resumes policies; anything broader lets it rewrite generated briefs."
  }

  # Stated separately from the set above, because this is the property and that
  # is only today's spelling of it. A grant over `briefs` would let the app that
  # renders a briefing also author one.
  assert {
    condition     = !contains(local.vercel_dashboard_kinds, "briefs")
    error_message = "The dashboard must hold no grant over briefs; the worker writes those and the app must not be able to forge one."
  }

  # The property neither file states on its own: the dashboard cannot forge a
  # briefing, and the worker cannot delete someone's CV. Both attachments filter
  # the same map by suffix, so this stays true only as long as nobody widens
  # either filter — which is exactly the edit worth failing a test.
  assert {
    condition = length(setintersection(
      toset(keys(aws_iam_role_policy_attachment.vercel_dashboard_user_storage)),
      toset(keys(aws_iam_role_policy_attachment.worker_user_storage)),
    )) == 0
    error_message = "The dashboard's and the worker's storage grants must be disjoint."
  }

  # The dashboard may *start* a briefing run and still not author one. That is
  # only true while this grant stays what it says it is, so both halves are
  # asserted: that it exists at all, and that it names one function.
  assert {
    condition     = length(aws_iam_role_policy.vercel_dashboard_invoke_worker) == 1
    error_message = "The dashboard needs lambda:InvokeFunction to start an ad-hoc run."
  }

  # A wildcard here would let the app invoke anything in the account — including
  # a future function with grants of its own — which is the confused-deputy
  # shape this whole stack is arranged to avoid.
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.vercel_dashboard_invoke_worker[0].statement :
      !contains(statement.resources, "*")
    ])
    error_message = "The invoke grant must name the worker's ARN, never `*`."
  }

  # Stated separately because it is the property, not its spelling: invoking is
  # not writing. If someone ever adds an `s3:` action to this document, the
  # storage assertions above would still pass and this is what would not.
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.vercel_dashboard_invoke_worker[0].statement :
      alltrue([for action in statement.actions : startswith(action, "lambda:")])
    ])
    error_message = "The invoke policy must grant nothing but lambda: actions; storage access belongs to the per-kind policies, which deliberately exclude briefs."
  }

  # A wildcard smuggled into a StringEquals value does not match broadly — it
  # never matches at all — so this fails closed rather than open. It is asserted
  # anyway because the failure is silent and looks like a credentials problem.
  assert {
    condition     = !anytrue([for subject in local.vercel_subjects : can(regex("[*?]", subject))])
    error_message = "Subject claims must be literal; the trust condition is StringEquals."
  }

  # All three pinned. Dropping any one of them widens the trust to every
  # project, or every deployment, that this issuer signs a token for.
  assert {
    condition = alltrue([
      for subject in local.vercel_subjects :
      startswith(subject, "owner:") && strcontains(subject, ":project:") && strcontains(subject, ":environment:")
    ])
    error_message = "Every subject must pin owner, project and environment; omitting one trusts every project or every deployment in the team."
  }

  # IAM condition keys name the issuer without its scheme. With `https://` left
  # on, the key is one no token ever carries and the condition can never match.
  assert {
    condition     = !strcontains(local.vercel_issuer_host, "https://")
    error_message = "The condition key must name the issuer host without a scheme."
  }

  assert {
    # `tolist` on the right, because `coalesce` gives the local a `list(string)`
    # type and a bare literal here is a tuple — `==` compares types as well as
    # elements and would fail on two identical lists.
    condition     = local.vercel_subjects == tolist(["owner:acme:project:control-panel:environment:production"])
    error_message = "Team-mode subjects must be derived from the slug, project and environment."
  }
}

# The default, and the state this stack ships in. CI applies this root on every
# push to `main` touching `infra/**`, so "unconfigured creates nothing" is what
# keeps an unfilled slug from being applied as a real role.
run "unconfigured_creates_nothing" {
  command = plan

  variables {
    vercel_dashboard = null
  }

  assert {
    condition     = length(aws_iam_role.vercel_dashboard) == 0
    error_message = "An unconfigured vercel_dashboard must create no role."
  }

  assert {
    condition     = length(aws_iam_role_policy_attachment.vercel_dashboard_user_storage) == 0
    error_message = "An unconfigured vercel_dashboard must attach no policy."
  }

  # Gated on the same `count` as the role it would attach to. A policy created
  # without one fails the apply rather than the plan, which is a worse place to
  # find out.
  assert {
    condition     = length(aws_iam_role_policy.vercel_dashboard_invoke_worker) == 0
    error_message = "An unconfigured vercel_dashboard must create no invoke policy."
  }

  # The other two stacks are untouched by the gate.
  assert {
    condition     = length(aws_iam_role_policy_attachment.worker_user_storage) == 1
    error_message = "Gating the dashboard stack must not affect the worker's grant."
  }
}

# Global issuer mode: no team path on the issuer, a bare audience, and subjects
# built from opaque ids. Nothing about it is derivable from the slug, so the
# overrides are the only way through — this run is what proves they are wired.
run "global_issuer_mode_overrides" {
  command = plan

  variables {
    vercel_dashboard = {
      team_slug  = "acme"
      issuer_url = "https://oidc.vercel.com"
      audience   = "https://vercel.com"
      subjects   = ["owner:team_abc123:project:prj_def456:environment:production"]
    }
  }

  assert {
    condition     = local.vercel_issuer_host == "oidc.vercel.com"
    error_message = "An explicit issuer_url must win over the slug-derived default."
  }

  assert {
    condition     = local.vercel_audience == "https://vercel.com"
    error_message = "An explicit audience must win over the slug-derived default."
  }

  assert {
    condition     = local.vercel_subjects == tolist(["owner:team_abc123:project:prj_def456:environment:production"])
    error_message = "Explicit subjects must win over the slug-derived default."
  }
}

# Preview deployments build whatever branch opened a pull request. Handing that
# build the production storage role would put every user's documents one
# unreviewed commit from being read out.
run "rejects_preview_environment" {
  command = plan

  variables {
    vercel_dashboard = {
      team_slug    = "acme"
      environments = ["production", "preview"]
    }
  }

  expect_failures = [var.vercel_dashboard]
}

# Same reasoning as the literal-subject assertion above, checked at the variable
# so a bad value never reaches the policy document.
run "rejects_wildcard_subject" {
  command = plan

  variables {
    vercel_dashboard = {
      team_slug = "acme"
      subjects  = ["owner:acme:project:control-panel:environment:*"]
    }
  }

  expect_failures = [var.vercel_dashboard]
}
