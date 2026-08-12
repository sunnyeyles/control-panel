# Partial backend configuration, on the same terms as the main root's: the block
# must exist for Terraform to use remote state at all, but the bucket is supplied
# at init time rather than written here.
#
# The chicken-and-egg was only real at creation time: `state.tf` in this root
# creates the bucket, so the first apply kept state on disk. ⚠️ That local file
# is currently the only copy of the state describing the role CI depends on —
# lose it and regaining control means importing seventeen resources by hand.
#
# Adopting the remote backend is one deliberate command, never an accident of
# the next `init`:
#
#   terraform -chdir=infra/aws/bootstrap init -migrate-state \
#     -backend-config="bucket=control-panel-tfstate-<account-id>" \
#     -backend-config="region=ap-southeast-2"
#
# Terraform prompts before copying and leaves the local state as a backup.
# `terraform init -backend=false` still works untouched, which is what the
# workflow's `validate` step uses, so a missing bucket cannot block a PR.
terraform {
  backend "s3" {
    key     = "bootstrap/terraform.tfstate"
    encrypt = true

    # Native S3 locking, matching the main root: needs Terraform >= 1.11 and no
    # DynamoDB table.
    use_lockfile = true
  }
}
