# The user-storage stack: one private bucket for per-user data, and the IAM
# policies that grant narrow access to it.
#
# Deliberately thin. Everything of substance is in the module — this file exists
# to name the module, hand it its configuration, and label what it creates.
#
# Fields absent from `var.user_storage` are absent from this block too, rather
# than passed as null: `object_kinds` and `attach_to_role_names` take the
# module's defaults because this root has no opinion about either.

module "user_storage" {
  source = "./modules/user-storage"

  bucket_name  = var.user_storage.bucket_name
  environments = var.user_storage.environments
  kms_key_arn  = var.user_storage.kms_key_arn

  # Tag taxonomy is the root's, not the module's. `Project`, `Environment` and
  # `ManagedBy` come from the provider's default_tags; `Component` is the one
  # tag that differs per stack, so it is set here where the stacks are visible
  # side by side rather than merged in inside each module.
  tags = {
    Component = "user-storage"
  }
}
