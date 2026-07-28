# Partial backend configuration, on the same terms as the main root's: the block
# must exist for Terraform to use remote state at all, but the bucket is supplied
# at init time rather than written here.
#
# The chicken-and-egg is over, and was only ever real at creation time. `state.tf`
# in this very root creates the bucket, so the *first* apply had nowhere remote to
# put its own state and kept it on disk. Every apply after that can keep it in S3
# — and should, because a local file on one laptop is currently the only copy of
# the state describing the role CI depends on. Lose it and regaining control of
# that role means importing seventeen resources by hand.
#
# Adopting it is one deliberate command rather than something that happens on the
# next `init` by accident:
#
#   terraform -chdir=infra/aws/bootstrap init -migrate-state \
#     -backend-config="bucket=control-panel-tfstate-<account-id>" \
#     -backend-config="region=ap-southeast-2"
#
# Terraform prompts before copying, and leaves the local `terraform.tfstate`
# behind as a backup rather than deleting it. Until that command is run, this
# block changes nothing about how the root behaves.
#
# `terraform init -backend=false` still works untouched, which is what the
# workflow's `validate` step uses — so a missing bucket cannot block a pull
# request.
terraform {
  backend "s3" {
    key     = "bootstrap/terraform.tfstate"
    encrypt = true

    # Native S3 locking, matching the main root: needs Terraform >= 1.11 and no
    # DynamoDB table.
    use_lockfile = true
  }
}
