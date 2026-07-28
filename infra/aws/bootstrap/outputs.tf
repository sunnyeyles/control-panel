output "state_bucket_name" {
  description = "Set as the TF_STATE_BUCKET repository variable, and use in `terraform init -backend-config`."
  value       = aws_s3_bucket.state.bucket
}

output "deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN repository variable."
  value       = aws_iam_role.deploy.arn
}

output "account_id" {
  description = "The account these stacks deploy into. Used to build globally unique bucket names."
  value       = data.aws_caller_identity.current.account_id
}
