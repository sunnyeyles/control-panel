# The worker stack.
#
# Kept in its own root file rather than added to main.tf so that the two stacks
# sharing this root — brief storage and the briefing worker — never edit the
# same file. Terraform reads every .tf in the directory as one configuration,
# so this composes exactly as an extra block in main.tf would, without the
# merge conflict.

locals {
  # Anchored to the root module rather than left relative, so a plan run from
  # the repository root and one run from inside this directory read the same
  # file. A variable default cannot call path.root, which is why this is a
  # local and the variable defaults to null.
  lambda_zip_path = coalesce(
    var.lambda_zip_path,
    "${path.root}/../../apps/briefing-worker/lambda.zip",
  )
}

module "briefing_worker" {
  source = "./modules/briefing-worker"

  function_name    = var.function_name
  lambda_zip_path  = local.lambda_zip_path
  alert_email      = var.alert_email
  schedule_enabled = var.schedule_enabled

  tags = {
    Component = "briefing-worker"
  }
}

# Joins the worker to the user-storage stack.
#
# That module creates no roles on purpose, and publishes policy ARNs for exactly
# this. Attaching from here rather than passing this role's name into its
# `attach_to_role_names` keeps the dependency one-way — the worker knows about
# storage, storage knows about nothing.
#
# Take the **narrow** grant. That module publishes both a per-environment set
# and a per-(environment, kind) set, and the worker wants the latter: it writes
# briefs, and a grant that also covers a user's uploaded documents is authority
# it has no use for. In practice that means `prod:briefs`, not `prod`.
#
# The storage module has now merged, so this references it directly rather than
# going through the placeholder variable that stood in while it was on its own
# branch. The filter is what keeps the grant narrow: `kind_access_policy_arns`
# is keyed `<environment>:<kind>`, and only the `:briefs` entries are taken.
#
# Every environment's briefs policy is attached, not just prod's, because one
# worker deployment per environment reads this same root — which environment it
# then writes to is `USER_STORAGE_ENVIRONMENT` on the function, not something
# decided here.
resource "aws_iam_role_policy_attachment" "worker_user_storage" {
  for_each = {
    for key, arn in module.user_storage.kind_access_policy_arns :
    key => arn if endswith(key, ":briefs")
  }

  role       = module.briefing_worker.execution_role_name
  policy_arn = each.value
}
