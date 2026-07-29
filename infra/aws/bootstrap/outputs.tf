output "state_bucket_name" {
  description = "Set as the TF_STATE_BUCKET repository variable, and use in `terraform init -backend-config`."
  value       = aws_s3_bucket.state.bucket
}

output "deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN repository variable."
  value       = aws_iam_role.deploy.arn
}

output "vercel_oidc_provider_url" {
  description = <<-EOT
    Issuer URL of the Vercel OIDC provider, or null when `vercel_team_slug` is
    unset and no provider was created.

    `infra/aws/vercel-dashboard.tf` looks the provider up by this URL rather
    than reading this root's state, which is a local file on one laptop — the
    same argument `infra/aws/boundary.tf` makes for resolving the permissions
    boundary by name. Set it as `vercel_dashboard.issuer_url` in
    `infra/aws/terraform.tfvars` if it differs from the derived default.
  EOT
  value       = one(aws_iam_openid_connect_provider.vercel[*].url)
}

output "account_id" {
  description = "The account these stacks deploy into. Used to build globally unique bucket names."
  value       = data.aws_caller_identity.current.account_id
}
