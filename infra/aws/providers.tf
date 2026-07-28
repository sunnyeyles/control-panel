provider "aws" {
  region = var.region

  # No credentials here, and none anywhere else in this tree. The provider
  # resolves them the same way the SDK in packages/user-storage does: through
  # the default chain — an OIDC-federated role in CI, a profile or SSO session
  # locally. An access key written into a .tf file ends up in state and in the
  # diff of every plan.

  # Only what is true of every resource in this root. `Component` is deliberately
  # absent: it differs per stack, and a default tag naming one stack would label
  # the other's resources wrongly. Each module block passes its own, and a
  # resource-level tag wins over a default anyway.
  #
  # `Environment` is a literal because this root deploys one environment. When a
  # second one exists it will be a second state file, not a second value here.
  default_tags {
    tags = {
      Project     = "control-panel"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}
