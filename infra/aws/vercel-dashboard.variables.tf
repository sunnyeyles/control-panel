# The third stack. See the note in user-storage.variables.tf for the two rules
# governing what appears in one of these objects and where its defaults live.
#
# Unlike the other two this variable defaults to null, and the stack creates
# nothing when it is. That is not a style break — it is the only safe default
# given how this root is applied. `.github/workflows/deploy-infra.yml` applies
# on every push to `main` touching `infra/**`, so a required field with a
# placeholder in terraform.tfvars would have CI create a role whose trust policy
# names a team that does not exist. Null means the role simply is not created
# until someone fills in the block, and the dashboard falls back to the SDK's
# default credential chain in the meantime.
variable "vercel_dashboard" {
  description = "Configuration for the Vercel dashboard's AWS access. Null creates nothing; see infra/aws/README.md for the values and where to read them."

  type = object({
    # The team **slug**, not the `orgId` in `.vercel/project.json` — that is an
    # opaque `team_…` identifier and appears in no claim.
    team_slug = string

    # Confirmed in `.vercel/project.json`. A field rather than a literal because
    # the trust policy pins it, so a second Vercel project under the same team
    # is a config change rather than a code change.
    project_name = optional(string, "control-panel")

    # Which Vercel deployment environments may assume the role. Production only,
    # and validated below to keep it that way.
    environments = optional(list(string), ["production"])

    # Escape hatches for Global issuer mode, where the issuer carries no team
    # path and the subject is built from opaque ids rather than slugs. Null
    # means "derive the team-mode strings". Read the real values off a decoded
    # `VERCEL_OIDC_TOKEN` before the first apply — `terraform test` cannot check
    # them, and a mismatch surfaces only as an AccessDenied at the first upload.
    issuer_url = optional(string)
    audience   = optional(string)
    subjects   = optional(list(string))
  })

  default = null

  # Preview deployments are built from whatever branch opened the pull request,
  # including one whose code nobody has read yet. Granting that build the
  # production storage role would put every user's uploaded documents one
  # unreviewed commit away from being read out — which is the whole reason the
  # subject condition pins `environment` at all, and this validation is what
  # stops the pin being widened back out by a config edit.
  validation {
    condition = var.vercel_dashboard == null || !anytrue([
      for environment in coalesce(try(var.vercel_dashboard.environments, null), ["production"]) :
      contains(["preview", "development"], lower(environment))
    ])
    error_message = "vercel_dashboard.environments must not include preview or development; those deployments build unreviewed code and must not hold production storage credentials."
  }

  # A wildcard here would defeat the StringEquals in the trust policy by
  # smuggling a pattern into its values. Cheap to check, and the failure it
  # prevents is silent.
  validation {
    condition = var.vercel_dashboard == null || !anytrue([
      for subject in coalesce(try(var.vercel_dashboard.subjects, null), []) :
      can(regex("[*?]", subject))
    ])
    error_message = "vercel_dashboard.subjects must be literal subject claims; the trust policy matches them with StringEquals, so a wildcard would never match rather than matching broadly."
  }
}
