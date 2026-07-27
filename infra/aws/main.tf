# The AWS root. Deliberately thin: everything of substance lives in the module,
# so that when the Lambda stack lands beside it this file can absorb a second
# module block without either side rewriting the other's work.

module "user_storage" {
  source = "./modules/user-storage"

  bucket_name          = var.bucket_name
  environments         = var.environments
  object_kinds         = var.object_kinds
  kms_key_arn          = var.kms_key_arn
  attach_to_role_names = var.attach_to_role_names
}
