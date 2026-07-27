terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # No backend block, deliberately. There is no state bucket yet, and a backend
  # pointing at one that does not exist makes `terraform init` fail rather than
  # degrade — which would block `validate` in CI for everyone. State is local
  # until the bootstrap described in README.md happens; see the same file for
  # the block to paste in afterwards.
}
