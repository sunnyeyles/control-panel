# The one committed .tfvars in this repository — `.gitignore` names it as the
# exception and says why. Nothing here is secret; all of it already appears in
# the READMEs.
#
# Auto-loaded, so `terraform apply` in this directory needs no flags and there
# is no way to run a half-configured apply. Overrides still work the usual way:
# `-var`, `TF_VAR_*`, or `-var-file` all beat this file.

# ---------------------------------------------------------------------------
# Cross-cutting
# ---------------------------------------------------------------------------

# Every alarm from every stack lands here. The SNS subscription needs one click
# in the confirmation mail AWS sends before anything is delivered.
alert_email = "sunnyeyles@gmail.com"

# ---------------------------------------------------------------------------
# Stacks
# ---------------------------------------------------------------------------

user_storage = {
  # Globally unique, and the account-id suffix is how. CHECK THIS BEFORE THE
  # FIRST APPLY: it must be the account the deploy role lives in. Once the
  # bucket exists, changing this name means creating a new empty bucket and
  # abandoning the old one's contents — `prevent_destroy` on the bucket will
  # stop the apply rather than let that happen quietly.
  bucket_name = "control-panel-user-storage-650694420748"
}

briefing_worker = {
  function_name = "briefing-worker"
}

# The dashboard's access to the user-storage bucket, via Vercel OIDC.
#
# Commented out rather than filled in with a placeholder, and unset it creates
# nothing. CI applies this root on every push to `main` touching `infra/**`, so
# a placeholder slug here would not sit harmlessly waiting to be corrected — it
# would be applied, producing a role whose trust policy names a team that does
# not exist. Unconfigured, the dashboard falls back to the SDK's default
# credential chain, which is what local development uses anyway.
#
# Before uncommenting:
#
#   1. `terraform -chdir=infra/aws/bootstrap apply -var="vercel_team_slug=…"`
#      (plus the flags bootstrap/README.md already documents) to create the OIDC
#      provider. The data source here fails without it.
#   2. Decode a real `VERCEL_OIDC_TOKEN` — it is a JWT — and check `iss`, `aud`
#      and `sub` against what the defaults derive. A project in Vercel's
#      *Global* issuer mode needs `issuer_url`, `audience` and `subjects` set
#      explicitly; the derived team-mode strings will not match. `terraform
#      test` cannot catch this, and the failure surfaces only as an AccessDenied
#      at the first upload.
#
# `team_slug` is the slug, not the `orgId` in `.vercel/project.json` — that is an
# opaque `team_…` identifier that appears in no claim. Read it off the team
# dashboard URL or from `vercel teams ls`.
#
# vercel_dashboard = {
#   team_slug = "<your-vercel-team-slug>"
# }
