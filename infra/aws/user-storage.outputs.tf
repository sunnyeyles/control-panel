output "user_storage_bucket_name" {
  description = "Set as USER_STORAGE_BUCKET_NAME on the workload."
  value       = module.user_storage.bucket_name
}

output "user_storage_bucket_region" {
  description = "Set as AWS_REGION on the workload."
  value       = module.user_storage.bucket_region
}

output "user_storage_policy_arns" {
  description = "Per-environment IAM policy ARNs, covering every object kind. The broad grant."
  value       = module.user_storage.access_policy_arns
}

output "user_storage_kind_policy_arns" {
  description = "Per-(environment, kind) IAM policy ARNs, keyed `<environment>:<kind>`. The narrow grant, and the one to prefer."
  value       = module.user_storage.kind_access_policy_arns
}
