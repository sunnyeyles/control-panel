provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "control-panel"
      Component = "bootstrap"
      ManagedBy = "terraform"
    }
  }
}
