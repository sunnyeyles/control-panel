terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # No backend, and the chicken-and-egg is real only at creation time: this
  # configuration creates the bucket the other root stores its state in, so the
  # first apply has nowhere remote to put its own state.
  #
  # `terraform.tfstate` here is therefore a local file, and `.gitignore` makes
  # committing it impossible — so today it lives on exactly one laptop, and
  # losing it means importing every resource in this root to regain control of
  # the role CI depends on. Once the state bucket exists that stops being
  # necessary; see README.md for the one-time `init -migrate-state`.
}
