output "vercel_dashboard_role_arn" {
  description = <<-EOT
    Set as AWS_ROLE_ARN on the Vercel project (Production). Null when the stack
    is not configured.

    Setting it is not sufficient on its own: **OIDC Federation must also be
    enabled** in the Vercel project's Security settings, or no token is injected,
    the dashboard silently falls back to the SDK's default credential chain, and
    every upload fails with no credentials rather than with anything naming this
    role. See infra/aws/DEPLOYING.md.
  EOT
  value       = one(aws_iam_role.vercel_dashboard[*].arn)
}
