output "function_name" {
  description = "Name of the Lambda function, for `aws lambda invoke` and log queries."
  value       = aws_lambda_function.worker.function_name
}

output "function_arn" {
  description = "ARN of the Lambda function."
  value       = aws_lambda_function.worker.arn
}

output "execution_role_name" {
  description = <<-EOT
    Name of the Lambda execution role.

    This is the integration point with the storage stack, which creates no
    roles on purpose so the two stacks never contend over one. Attach a
    per-environment access policy to this role, or pass this name into that
    module's `attach_to_role_names`.
  EOT
  value       = aws_iam_role.execution.name
}

output "execution_role_arn" {
  description = "ARN of the Lambda execution role, for policies written outside this module."
  value       = aws_iam_role.execution.arn
}

output "log_group_name" {
  description = "CloudWatch log group holding the run reports."
  value       = aws_cloudwatch_log_group.worker.name
}

output "openai_secret_arn" {
  description = "ARN of the (empty) OpenAI key secret. Set its value out-of-band; Terraform never writes it."
  value       = aws_secretsmanager_secret.openai.arn
}

output "alerts_topic_arn" {
  description = "SNS topic the failure and missed-run alarms publish to."
  value       = aws_sns_topic.alerts.arn
}
