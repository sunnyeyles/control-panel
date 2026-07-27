# Partial backend configuration: the block must exist for Terraform to use
# remote state at all, but the bucket is supplied at init time rather than
# written here.
#
# This is what lets one file serve a bucket that does not exist yet. `versions.tf`
# notes that state is local until a bootstrap happens — that note describes the
# state before this file existed, and `infra/aws/bootstrap/` is the bootstrap it
# refers to. Once bootstrap has been applied:
#
#   terraform init -backend-config=backend.hcl          # locally
#   terraform init -backend-config="bucket=$TF_STATE_BUCKET" ...   # in CI
#
# `terraform init -backend=false` still works untouched, which is what
# `fmt`/`validate` use and why a missing bucket cannot block a pull request.
terraform {
  backend "s3" {
    key     = "briefing-worker/terraform.tfstate"
    encrypt = true

    # Native S3 locking, which needs Terraform >= 1.11 and no DynamoDB table.
    # The old dynamodb_table argument is deprecated; a lock file in the state
    # bucket removes a second resource that had to exist, be paid for, and be
    # kept in sync with the bucket it guarded.
    use_lockfile = true
  }
}
