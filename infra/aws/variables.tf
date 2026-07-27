variable "region" {
  description = "AWS region for this root — the user-storage bucket and the briefing worker alike."
  type        = string
  default     = "ap-southeast-2"
}

variable "bucket_name" {
  description = "Globally unique name for the user-storage bucket. No default: an accidentally shared default is how two deployments end up writing into one bucket."
  type        = string
}

variable "environments" {
  description = "Environments that get their own key prefix and IAM policy."
  type        = list(string)
  default     = ["dev", "prod"]
}

variable "environment_label" {
  description = "Value for the Environment tag on the shared bucket. The bucket spans environments, so this labels the deployment, not the data inside it."
  type        = string
  default     = "shared"
}

variable "object_kinds" {
  description = "Categories of user data and their retention. Keys must match packages/user-storage/src/kinds.ts. Null defaults to the module's own briefs/resumes definition."
  type = map(object({
    expiration_days                    = optional(number)
    noncurrent_version_expiration_days = optional(number, 90)
  }))

  default = {
    briefs = {
      expiration_days                    = 365
      noncurrent_version_expiration_days = 30
    }
    resumes = {
      expiration_days                    = null
      noncurrent_version_expiration_days = 365
    }
  }
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for at-rest encryption. Null uses SSE-S3."
  type        = string
  default     = null
}

variable "attach_to_role_names" {
  description = <<-EOT
    IAM role names to attach each environment's *broad* per-environment access
    policy to, keyed by environment.

    Empty, and expected to stay that way. The briefing worker — the one consumer
    so far — is joined the other way round, in `briefing-worker.tf`, which
    attaches the narrow per-kind grant to its own execution role. That keeps the
    dependency one-way: the worker knows about storage, storage knows about
    nothing. Reach for this only for a role this root does not create.
  EOT
  type        = map(list(string))
  default     = {}
}
