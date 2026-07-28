terraform {
  # 1.11, not 1.9, and backend.tf is why: `use_lockfile` is a 1.11 argument and
  # 1.9 rejects it at `init` with an unsupported-argument error rather than
  # falling back. Pinning the floor here makes that a version check instead of a
  # confusing init failure.
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
