output "worker_function_name" {
  description = "Pass to `aws lambda invoke` to force a run."
  value       = module.briefing_worker.function_name
}

output "worker_execution_role_name" {
  description = "Attach user-storage access policies to this role — the per-kind ones, not the per-environment ones."
  value       = module.briefing_worker.execution_role_name
}

output "worker_log_group_name" {
  description = "Where the proof-run lines land."
  value       = module.briefing_worker.log_group_name
}

output "worker_openai_secret_arn" {
  description = "Set this secret's value by hand; Terraform creates it empty and never writes it."
  value       = module.briefing_worker.openai_secret_arn
}

output "worker_alerts_topic_arn" {
  description = "SNS topic for worker alarms. The email subscription needs confirming before anything is delivered."
  value       = module.briefing_worker.alerts_topic_arn
}
