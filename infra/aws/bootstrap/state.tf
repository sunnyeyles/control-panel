data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# Terraform state
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket_name

  # State is the one thing here whose loss is not recoverable by re-running
  # anything, so deleting this bucket should take an edit to this file.
  lifecycle {
    prevent_destroy = true
  }
}

# The undo button for state. A corrupted or truncated state file is recoverable
# by rolling back to the previous version; without this it is recoverable by
# hand-importing every resource.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# State holds every resource attribute Terraform has ever read, which for some
# providers includes generated credentials. Public access is blocked at the
# bucket level rather than trusted to object ACLs.
resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
