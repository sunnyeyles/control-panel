variable "bucket_name" {
  description = "Globally unique name for the user-storage bucket. One bucket holds every environment, separated by the leading key segment."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be 3-63 characters, lowercase alphanumeric with dots and dashes, starting and ending alphanumeric."
  }
}

variable "environments" {
  description = <<-EOT
    Environments that get an IAM access policy. Each name is the leading
    segment of the object keys that environment's workload may touch, so the
    policy generated for `prod` cannot read or write `dev/`.
  EOT
  type        = list(string)

  # No default, deliberately. The caller's root declares one — and passing
  # `null` to a module input does not fall back to a module default, so a
  # default here would be dead code that nonetheless reads as authoritative.
  # Requiring the value also means no deployment gets an environment layout it
  # never chose.

  validation {
    condition     = length(var.environments) > 0
    error_message = "At least one environment is required, or nothing can reach the bucket."
  }

  validation {
    condition     = alltrue([for e in var.environments : can(regex("^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$", e))])
    error_message = "Environment names must match the key-segment rule enforced in packages/user-storage/src/keys.ts; a name with a slash or dot-segment would break prefix scoping."
  }
}

variable "object_kinds" {
  description = <<-EOT
    Categories of user data, and how long each is kept. The map keys must match
    the kinds declared in `packages/user-storage/src/kinds.ts` — the store tags
    every object with its kind, and these lifecycle rules filter on that tag.

    `expiration_days = null` means never expire. That is the right default for
    anything the user uploaded themselves: silently deleting someone's own
    document is data loss, not housekeeping.
  EOT
  type = map(object({
    expiration_days                    = optional(number)
    noncurrent_version_expiration_days = optional(number, 90)
  }))

  default = {
    # Regenerated daily. A year of history is plenty, and unbounded growth of
    # machine-generated text is pure cost.
    briefs = {
      expiration_days                    = 365
      noncurrent_version_expiration_days = 30
    }

    # Drafted once, for one advertisement, in the user's own voice — and they
    # may already have relied on it. Never expired automatically, the same
    # posture as `resumes` and deliberately **not** the `briefs` one: a brief is
    # regenerated daily and expiring a year of them is housekeeping, while
    # deleting a letter is data loss. Superseded drafts are kept a year, which
    # is what makes re-drafting a Posting non-destructive.
    cover-letters = {
      expiration_days                    = null
      noncurrent_version_expiration_days = 365
    }

    # Generated once, for one advertisement, out of the user's own CV — and
    # they may already have applied with it. Same posture as `cover-letters`
    # for the same reason: a brief is regenerated daily and expiring a year of
    # them is housekeeping, while deleting this is data loss. Superseded
    # versions are kept a year, which is what makes re-generating for a Posting
    # non-destructive.
    tailored-resumes = {
      expiration_days                    = null
      noncurrent_version_expiration_days = 365
    }

    # The user's own upload. Never expired automatically; superseded versions
    # are kept a year so a mistaken re-upload is recoverable.
    resumes = {
      expiration_days                    = null
      noncurrent_version_expiration_days = 365
    }
  }

  validation {
    condition     = length(var.object_kinds) > 0
    error_message = "At least one object kind is required."
  }

  validation {
    condition     = alltrue([for k in keys(var.object_kinds) : can(regex("^[a-z][a-z0-9-]*$", k))])
    error_message = "Object kind names must be lowercase alphanumeric with dashes, matching the key segment they become."
  }
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for at-rest encryption. Null uses SSE-S3 (AES256), which is free and needs no key policy; set this only when a compliance regime demands a key you control and rotate."
  type        = string
  default     = null
}

variable "attach_to_role_names" {
  description = <<-EOT
    IAM role names to attach the per-environment access policies to, keyed by
    environment. This module creates no roles: an execution role belongs to the
    workload's own stack, and creating it here would make two stacks fight over
    one resource. Leave empty and consume the policy ARNs from the outputs
    instead.

    Example: { prod = ["briefing-worker-prod"] }
  EOT
  type        = map(list(string))
  default     = {}
}

variable "tags" {
  description = "Tags applied verbatim to every resource this module creates. The module adds nothing of its own — the root owns the tag taxonomy, so `Component` comes from there rather than being merged in here where it could disagree."
  type        = map(string)
  default     = {}
}
