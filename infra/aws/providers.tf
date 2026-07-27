provider "aws" {
  region = var.region

  # No credentials here, and none anywhere else in this tree. The provider
  # resolves them the same way the SDK in packages/user-storage does: through
  # the default chain — an OIDC-federated role in CI, a profile or SSO session
  # locally. An access key written into a .tf file ends up in state and in the
  # diff of every plan.

  default_tags {
    tags = {
      Project     = "control-panel"
      Component   = "user-storage"
      Environment = var.environment_label
      ManagedBy   = "terraform"
    }
  }
}
