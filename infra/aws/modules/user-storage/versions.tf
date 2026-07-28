terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # The dedicated bucket-setting resources used here (versioning, public
      # access block, ownership controls) are the v4+ split of what used to be
      # inline blocks on aws_s3_bucket. Pinning the major keeps a `terraform
      # init` from silently picking up the next breaking rearrangement.
      version = "~> 6.0"
    }
  }
}
