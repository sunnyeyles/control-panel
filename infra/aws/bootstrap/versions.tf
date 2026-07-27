terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # No backend, and this is the one root where that is permanent rather than
  # temporary: this configuration creates the bucket the other root stores its
  # state in, and state cannot live inside the thing it is about to create.
  # `terraform.tfstate` here is a local file — commit it or keep it, but know
  # that losing it means importing three resources rather than losing an
  # environment.
}
