# The one committed .tfvars in this repository — `.gitignore` names it as the
# exception and says why. Nothing here is secret; all of it already appears in
# the READMEs.
#
# Auto-loaded, so `terraform apply` in this directory needs no flags and there
# is no way to run a half-configured apply. Overrides still work the usual way:
# `-var`, `TF_VAR_*`, or `-var-file` all beat this file.

# ---------------------------------------------------------------------------
# Cross-cutting
# ---------------------------------------------------------------------------

# Every alarm from every stack lands here. The SNS subscription needs one click
# in the confirmation mail AWS sends before anything is delivered.
alert_email = "sunnyeyles@gmail.com"

# ---------------------------------------------------------------------------
# Stacks
# ---------------------------------------------------------------------------

user_storage = {
  # Globally unique, and the account-id suffix is how. CHECK THIS BEFORE THE
  # FIRST APPLY: it must be the account the deploy role lives in. Once the
  # bucket exists, changing this name means creating a new empty bucket and
  # abandoning the old one's contents — `prevent_destroy` on the bucket will
  # stop the apply rather than let that happen quietly.
  bucket_name = "control-panel-user-storage-227119264248"
}

briefing_worker = {
  function_name = "briefing-worker"
}
