# Cross-cutting inputs only — the things that are true of the root rather than
# of one stack in it. Everything a single stack configures lives in that stack's
# own `<stack>.variables.tf`, as one object variable.
#
# The rule that keeps this file from growing: a new stack adds a file, not a
# name here.

variable "region" {
  description = "AWS region every stack in this root deploys into."
  type        = string
  default     = "ap-southeast-2"
}

variable "alert_email" {
  description = <<-EOT
    Address that receives every alarm from every stack, via the shared topic in
    `alerting.tf`.

    No default, on purpose. Alerting that silently switches itself off is the
    exact failure the alarms exist to catch, so an unset value must break the
    apply rather than quietly produce an unmonitored deployment. AWS sends a
    confirmation mail that must be clicked before anything is delivered.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.alert_email))
    error_message = "alert_email must be a single valid email address."
  }
}
