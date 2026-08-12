# Vercel OIDC, so the dashboard can reach the user-storage bucket.
#
# Here rather than in `infra/aws/` because `deploy-iam.tf` grants nothing in the
# `iam:*OpenIDConnectProvider*` family: the deploy role can create the *role*
# (`control-panel-vercel-dashboard` matches `managed_role_arn_patterns`) but not
# the provider it federates against. The root looks this up by URL.
#
# Same shape and reasoning as `oidc.tf` — a short-lived token per invocation, no
# access key on the dashboard side.
#
# Everything is gated on `vercel_team_slug`, so an apply without it creates
# nothing new.

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

  # Empty and then ignored, for the reasons `oidc.tf` gives: AWS validates the
  # certificate against its own trust store, and repopulates this list right
  # after creation, so without `ignore_changes` every plan reports a change that
  # never converges.
  thumbprint_list = []

  lifecycle {
    ignore_changes = [thumbprint_list]
  }
}
