# The briefing-worker stack: a Lambda, the schedule that fires it, the secret it
# reads, and the alarms that notice when it stops.
#
# One file per stack, and Terraform reads every .tf in the directory as one
# configuration — so this composes exactly as an extra block in a shared file
# would, without two stacks ever editing the same lines.

locals {
  # Anchored to the root module rather than left relative, so a plan run from
  # the repository root and one run from inside this directory read the same
  # file. A variable default cannot call path.root, which is why this is a
  # local and the object field defaults to null.
  lambda_zip_path = coalesce(
    var.briefing_worker.lambda_zip_path,
    "${path.root}/../../apps/briefing-worker/lambda.zip",
  )
}

module "briefing_worker" {
  source = "./modules/briefing-worker"

  function_name                = var.briefing_worker.function_name
  langfuse_base_url            = var.briefing_worker.langfuse_base_url
  langfuse_tracing_environment = var.briefing_worker.langfuse_tracing_environment
  lambda_zip_path              = local.lambda_zip_path

  schedule_enabled = var.schedule_enabled

  # From the user-storage stack's output rather than restated here, so the two
  # cannot disagree about which bucket exists. This reference is also what makes
  # Terraform build the bucket before the function that writes to it.
  user_storage_bucket_name = module.user_storage.bucket_name

  # The shared topic, created in alerting.tf. The module states which alarms
  # exist; where they are delivered is the root's business.
  alerts_topic_arn = aws_sns_topic.alerts.arn

  # Not optional in practice — the deploy role may only create roles that carry
  # it. See boundary.tf.
  permissions_boundary_arn = data.aws_iam_policy.workload_boundary.arn

  tags = {
    Component = "briefing-worker"
  }
}

# Joins the worker to the user-storage stack.
#
# That module creates no roles on purpose and publishes policy ARNs for exactly
# this. Attaching from here, rather than passing this role's name into its
# `attach_to_role_names`, keeps the dependency one-way.
#
# Take the **narrow** grant: `prod:briefs`, not `prod`. The worker writes briefs,
# and a grant covering a user's uploaded documents is authority it has no use
# for. `kind_access_policy_arns` is keyed `<environment>:<kind>`, and every
# environment's `:briefs` entry is taken rather than a named one — which
# environment is actually written to is `USER_STORAGE_ENVIRONMENT` on the
# function, not something decided at attachment time.
resource "aws_iam_role_policy_attachment" "worker_user_storage" {
  for_each = {
    for key, arn in module.user_storage.kind_access_policy_arns :
    key => arn if endswith(key, ":briefs")
  }

  role       = module.briefing_worker.execution_role_name
  policy_arn = each.value
}
