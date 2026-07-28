terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # The backend lives in backend.tf, and is partial — the bucket is supplied at
  # init time. It is not adopted until someone runs `init -migrate-state`; read
  # that file for why the move is worth making and why it is a deliberate step
  # rather than an automatic one.
}
