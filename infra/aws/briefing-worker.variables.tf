# Only the fields a deployment varies; see the note in user-storage.variables.tf
# for the two rules governing what appears here and where defaults live. The
# schedule expression, timezone, memory, timeout and log retention are not
# exposed, because this root has no opinion about any of them — the reasoning
# behind each value is in modules/briefing-worker/variables.tf, which is where
# it should be read and changed.
variable "briefing_worker" {
  description = "Configuration for the briefing-worker stack. Fields are documented in modules/briefing-worker/variables.tf."

  type = object({
    function_name = optional(string, "briefing-worker")

    # Null means "the package's own build output", resolved against this
    # directory in briefing-worker.tf — a variable default cannot call
    # path.root, which is why the fallback is a local rather than a default.
    lambda_zip_path = optional(string)
  })

  default = {}
}

# Flat, and the one stack input that is, because it is the only one ever set
# from a command line:
#
#   terraform apply -var="schedule_enabled=false"
#
# An object field cannot be overridden that way without restating the whole
# object, which would turn "take the worker off duty" — a step DEPLOYING.md
# documents for exactly the moment when things are going wrong — into an
# exercise in retyping configuration correctly under pressure.
#
# The rule this encodes: configuration lives in the stack's object, operational
# overrides stay flat.
variable "schedule_enabled" {
  description = "Whether the briefing worker's daily schedule fires. False deploys it without putting it on duty — the function stays manually invocable, which is how to verify a change before it starts writing a brief a day."
  type        = bool
  default     = true
}
