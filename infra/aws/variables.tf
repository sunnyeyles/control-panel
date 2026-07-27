variable "region" {
  description = "AWS region for the user-storage bucket."
  type        = string
  default     = "ap-southeast-2"
}

variable "environment_label" {
  description = "Value for the Environment tag on the shared bucket. The bucket spans environments, so this labels the deployment, not the data inside it."
  type        = string
  default     = "shared"
}
