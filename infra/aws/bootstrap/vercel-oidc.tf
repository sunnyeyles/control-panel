# ---------------------------------------------------------------------------
# Vercel OIDC, so the dashboard can reach the user-storage bucket
# ---------------------------------------------------------------------------
#
# Why this is here rather than in `infra/aws/`, where the role that uses it
# lives: `deploy-iam.tf` grants nothing in the `iam:*OpenIDConnectProvider*`
# family. The deploy role can create the *role* — `control-panel-vercel-dashboard`
# matches `managed_role_arn_patterns` — but it cannot create the provider that
# role federates against. So the provider is a bootstrap concern, applied by
# hand with admin, and the root looks it up by URL.
#
# Same shape as `oidc.tf`, and for the same reason: Vercel mints a short-lived
# token per invocation and AWS exchanges it for temporary credentials. There is
# no access key on the dashboard side either.
#
# Optional. Everything here is gated on `vercel_team_slug`, so `terraform apply`
# with the two flags `bootstrap/README.md` documents still works untouched and
# creates nothing new. Supply the slug when the dashboard is ready to store
# documents.

locals {
  vercel_enabled = var.vercel_team_slug != null

  # Team issuer mode. Vercel also offers a *Global* mode whose issuer carries no
  # team path and whose audience is the bare `https://vercel.com` — the
  # overrides exist for that, because which mode a project uses is a setting in
  # the Vercel dashboard rather than something derivable from the slug.
  #
  # Read the real values off a token rather than trusting either default:
  # `VERCEL_OIDC_TOKEN` is a JWT, and `iss` and `aud` are in its payload.
  vercel_issuer_url = coalesce(
    var.vercel_oidc_issuer_url,
    "https://oidc.vercel.com/${var.vercel_team_slug}"
  )

  vercel_audience = coalesce(
    var.vercel_oidc_audience,
    "https://vercel.com/${var.vercel_team_slug}"
  )
}

resource "aws_iam_openid_connect_provider" "vercel" {
  count = local.vercel_enabled ? 1 : 0

  url            = local.vercel_issuer_url
  client_id_list = [local.vercel_audience]

  # Empty and then ignored, for the reasons `oidc.tf` sets out at length: AWS
  # validates the provider's certificate against its own trust store rather
  # than a pinned thumbprint, and it repopulates this list of its own accord
  # immediately after creation. Without `ignore_changes` every future plan of
  # this hand-applied root reports a change that never converges, and "no
  # changes" stops being the signal that the file and the account agree.
  thumbprint_list = []

  lifecycle {
    ignore_changes = [thumbprint_list]
  }
}
