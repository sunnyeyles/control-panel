# One object rather than one variable per module input.
#
# Flat top-level variables meant copied descriptions that drifted, and a third
# stack would have added five more names to the same namespace. Two rules:
#
#   1. Only fields a *deployment* varies appear here. `object_kinds` and
#      `attach_to_role_names` are not exposed — an unexposed field is not passed
#      at all, so the module's default applies.
#
#   2. ⚠️ Where a default is written here, the module's variable has none.
#      Passing `null` to a module input does *not* fall back to that module's
#      default — it arrives as null and breaks whatever reads it.
#
# Field-level documentation is not repeated: `modules/user-storage/variables.tf`
# is the single source for what each field means and validates.
variable "user_storage" {
  description = "Configuration for the user-storage stack. Fields are documented in modules/user-storage/variables.tf."

  type = object({
    bucket_name = string

    # One environment, because there is one. A `dev` entry here is not a dev
    # environment — it is three unused IAM policies and a key prefix nothing
    # writes to. Add the second name when a second deployment exists.
    environments = optional(list(string), ["prod"])

    # Null is a real value here, not an absent one: it selects SSE-S3, which is
    # free and needs no key policy.
    kms_key_arn = optional(string)
  })
}
