variable "region" {
  description = "AWS region for the state bucket. Matches the region the stacks deploy into so that state and infrastructure share a fate."
  type        = string
  default     = "ap-southeast-2"
}

variable "state_bucket_name" {
  description = <<-EOT
    Globally unique name for the Terraform state bucket.

    No default. A shared default is how two projects end up overwriting one
    another's state, which is the worst failure in this file's blast radius.
    The convention used elsewhere here is `control-panel-tfstate-<account-id>`.
  EOT
  type        = string
}

variable "github_owner" {
  description = "GitHub account or organisation that owns the repository CI runs from."
  type        = string
}

variable "github_repo" {
  description = "Repository name CI runs from."
  type        = string
  default     = "control-panel"
}

variable "github_subject_patterns" {
  description = <<-EOT
    Subject claims allowed to assume the deploy role, matched with StringLike.

    Read this before changing it. GitHub moved to **immutable subject claims**
    on 2026-07-15: for repositories created after that date the `sub` embeds
    numeric owner and repository IDs — `repo:owner@1234/name@5678:ref:...` —
    not the `repo:owner/name:ref:...` form that every example online still
    shows. A trust policy written from those examples fails to assume with an
    error that names no cause.

    The default accepts both shapes for the main branch only, which is
    deliberately permissive to make the first deploy work. Tighten it once the
    real value is known: it appears in the CloudTrail
    `AssumeRoleWithWebIdentity` event, under
    `userIdentity.sessionContext.sessionIssuer` / the request parameters.

    Branch-scoped, not repository-scoped, either way: `:ref:refs/heads/main`
    means a pull request from a fork cannot mint a token that deploys.
  EOT
  type        = list(string)
  default     = null
}

variable "deployed_secret_arn_pattern" {
  description = "ARN pattern for secrets the deploy role may manage the shell of but never read. Defaults to every secret in the account."
  type        = string
  default     = "*"
}
