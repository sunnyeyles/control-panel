output "bucket_name" {
  description = "Set this as USER_STORAGE_BUCKET_NAME on anything that stores user data."
  value       = aws_s3_bucket.user_storage.bucket
}

output "bucket_arn" {
  description = "The bucket ARN, for policies written outside this module."
  value       = aws_s3_bucket.user_storage.arn
}

output "bucket_region" {
  description = "Region the bucket was created in. Set this as AWS_REGION where the client cannot infer it."
  value       = aws_s3_bucket.user_storage.region
}

output "access_policy_arns" {
  description = <<-EOT
    Per-environment IAM policy ARNs, keyed by environment name. Covers every
    object kind in that environment.

    This is the broad grant. Prefer `kind_access_policy_arns` for a workload
    that only touches one category — the scheduled worker writes briefs and has
    no business deleting a user's CV.
  EOT
  value       = { for environment, policy in aws_iam_policy.access : environment => policy.arn }
}

output "kind_access_policy_arns" {
  description = <<-EOT
    Per-(environment, kind) IAM policy ARNs, keyed `<environment>:<kind>` —
    e.g. `prod:briefs`. The narrow grant, and the one to reach for first.

    No role is created here on purpose, so the two stacks never contend over
    one. Attach the ARN to the workload's execution role from its own stack.
  EOT
  value       = { for key, policy in aws_iam_policy.kind_access : key => policy.arn }
}
