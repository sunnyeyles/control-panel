# Private storage for per-user data — generated Markdown briefs and documents
# the user uploaded themselves.
#
# The bucket is private, encrypted and versioned, and nothing in this module
# grants public read — there is no website configuration, no ACL, no presigned
# URL. Objects are read back through the application using the caller's own
# credentials, which is what keeps a leaked key from becoming a leaked corpus.

locals {
  # One flattened attachment per (environment, role) pair, so a role can be
  # granted access to more than one environment without the map needing a
  # composite key.
  role_attachments = merge([
    for environment, role_names in var.attach_to_role_names : {
      for role_name in role_names :
      "${environment}:${role_name}" => {
        environment = environment
        role_name   = role_name
      }
    }
  ]...)

  # Every (environment, kind) pair, for the narrow per-kind policies below.
  environment_kinds = merge([
    for environment in var.environments : {
      for kind in keys(var.object_kinds) :
      "${environment}:${kind}" => {
        environment = environment
        kind        = kind
      }
    }
  ]...)
}

resource "aws_s3_bucket" "user_storage" {
  bucket = var.bucket_name
  tags   = var.tags
}

# Belt and braces against the single worst outcome for this bucket. It now
# holds documents the user uploaded, so a public object here is a personal-data
# breach rather than a leaked summary. The account may or may not have the
# equivalent block set; this pins it at the bucket so the guarantee does not
# depend on account-level configuration staying put.
resource "aws_s3_bucket_public_access_block" "user_storage" {
  bucket = aws_s3_bucket.user_storage.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Disables ACLs outright. With ownership enforced, `public-read` on an object
# is not merely blocked but unrepresentable, which removes the whole category
# of "one object was uploaded with the wrong ACL".
resource "aws_s3_bucket_ownership_controls" "user_storage" {
  bucket = aws_s3_bucket.user_storage.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Versioning is the undo button, and it matters more for uploads than for
# generated text: a user who replaces their CV with the wrong file has not lost
# the old one. It is also why the store's `delete` is safe to expose.
resource "aws_s3_bucket_versioning" "user_storage" {
  bucket = aws_s3_bucket.user_storage.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "user_storage" {
  bucket = aws_s3_bucket.user_storage.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }

    # Only meaningful under KMS, where it collapses per-object key requests
    # into one per bucket-key period. Harmless otherwise, and a large cost
    # difference at object-per-user-per-day volumes.
    bucket_key_enabled = var.kms_key_arn != null
  }
}

data "aws_iam_policy_document" "bucket" {
  # Encryption at rest is configured above; this is the in-transit half. S3
  # serves plain HTTP unless told otherwise, so without this a misconfigured
  # client could send a CV in the clear and nothing would object.
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.user_storage.arn,
      "${aws_s3_bucket.user_storage.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "user_storage" {
  bucket = aws_s3_bucket.user_storage.id
  policy = data.aws_iam_policy_document.bucket.json

  # The policy denies on a condition rather than granting anything, so it is
  # safe alongside the public access block — but the block must exist first,
  # or there is a window where the bucket is policy-governed and not yet
  # public-access-blocked.
  depends_on = [aws_s3_bucket_public_access_block.user_storage]
}

# Retention differs per kind, and the mechanism is worth explaining because it
# is not the obvious one.
#
# S3 lifecycle filters match a *literal* prefix — no wildcards. The key layout
# is `environment/userId/kind/…`, so there is no prefix that means "every
# user's briefs": userId sits between the two fixed parts. Putting kind above
# userId would fix lifecycle but scatter a user's data across kinds, making
# erasure N deletes instead of one.
#
# So the store tags every object with `kind=<kind>` at write time and these
# rules filter on the tag instead. That is the only reason briefs and resumes
# can be retained differently at all — and it is why a kind added to
# `kinds.ts` without a matching entry here silently gets no retention policy.
resource "aws_s3_bucket_lifecycle_configuration" "user_storage" {
  bucket = aws_s3_bucket.user_storage.id

  # A failed multipart upload otherwise bills for its parts indefinitely while
  # being invisible in the console's object list. Applies bucket-wide.
  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Without this, a deleted object leaves a delete marker behind forever. They
  # are free to store but they slow every LIST that walks past them.
  rule {
    id     = "expire-orphaned-delete-markers"
    status = "Enabled"

    filter {}

    expiration {
      expired_object_delete_marker = true
    }
  }

  dynamic "rule" {
    for_each = var.object_kinds

    content {
      id     = "retain-${rule.key}"
      status = "Enabled"

      filter {
        tag {
          key   = "kind"
          value = rule.key
        }
      }

      # Only emitted when the kind sets one. A resume has no expiration block
      # at all rather than an expiration set to something large — the absence
      # is the guarantee.
      dynamic "expiration" {
        for_each = rule.value.expiration_days == null ? [] : [rule.value.expiration_days]

        content {
          days = expiration.value
        }
      }

      noncurrent_version_expiration {
        noncurrent_days = rule.value.noncurrent_version_expiration_days
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.user_storage]
}

# One policy per environment, covering every kind. Splitting by environment is
# the point: the identity running the production workload gets a policy that
# cannot name a `dev/` key.
data "aws_iam_policy_document" "access" {
  for_each = toset(var.environments)

  # Object verbs, scoped to this environment's prefix. Deliberately enumerated:
  # not `s3:*`, and notably not `s3:PutObjectAcl` (which ownership enforcement
  # already neuters) or any bucket-level verb.
  statement {
    sid    = "ReadWriteDeleteObjects"
    effect = "Allow"

    actions = [
      "s3:PutObject",
      # Setting the kind tag during PutObject needs its own permission — the
      # write would 403 without it, and the lifecycle rules above depend on
      # that tag existing.
      "s3:PutObjectTagging",
      "s3:GetObject",
      "s3:GetObjectTagging",
      "s3:DeleteObject",
    ]

    # HeadObject is authorised by s3:GetObject, so the store's head-before-
    # delete needs no extra grant.
    resources = ["${aws_s3_bucket.user_storage.arn}/${each.key}/*"]
  }

  # ListBucket is a bucket-level action, so the prefix cannot be expressed in
  # the resource ARN — it has to be a condition, or this would grant the
  # ability to enumerate every environment and every user in the bucket.
  statement {
    sid    = "ListOwnEnvironmentOnly"
    effect = "Allow"

    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.user_storage.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${each.key}/*"]
    }
  }

  # Only present under a customer-managed key: SSE-S3 needs no KMS grant at
  # all, and emitting an empty-resource KMS statement would be a policy that
  # grants decrypt on nothing while looking like it grants it on something.
  dynamic "statement" {
    for_each = var.kms_key_arn == null ? [] : [var.kms_key_arn]

    content {
      sid    = "UseBucketEncryptionKey"
      effect = "Allow"

      actions = [
        "kms:Decrypt",
        "kms:GenerateDataKey",
      ]

      resources = [statement.value]
    }
  }
}

resource "aws_iam_policy" "access" {
  for_each = data.aws_iam_policy_document.access

  name        = "${var.bucket_name}-${each.key}-user-storage"
  description = "Read, write and delete every kind of user data under ${each.key}/ in ${var.bucket_name}."
  policy      = each.value.json
  tags        = var.tags
}

# Narrower still: one policy per (environment, kind).
#
# Now that the bucket holds two quite differently sensitive things, "the
# scheduled worker can write briefs" and "the scheduled worker can delete a
# user's CV" should not be the same grant. IAM resource ARNs do take wildcards,
# so unlike lifecycle this can be expressed as a prefix with userId wildcarded.
data "aws_iam_policy_document" "kind_access" {
  for_each = local.environment_kinds

  statement {
    sid    = "ReadWriteDeleteOneKind"
    effect = "Allow"

    actions = [
      "s3:PutObject",
      "s3:PutObjectTagging",
      "s3:GetObject",
      "s3:GetObjectTagging",
      "s3:DeleteObject",
    ]

    resources = [
      "${aws_s3_bucket.user_storage.arn}/${each.value.environment}/*/${each.value.kind}/*",
    ]
  }

  # `s3:prefix` is matched against the literal prefix the caller asks to list,
  # and the store lists `environment/userId/kind/`. StringLike with a wildcard
  # for the user is what permits that without permitting a bare listing of the
  # whole environment.
  statement {
    sid    = "ListOneKindOnly"
    effect = "Allow"

    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.user_storage.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${each.value.environment}/*/${each.value.kind}/*"]
    }
  }

  dynamic "statement" {
    for_each = var.kms_key_arn == null ? [] : [var.kms_key_arn]

    content {
      sid       = "UseBucketEncryptionKey"
      effect    = "Allow"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_policy" "kind_access" {
  for_each = data.aws_iam_policy_document.kind_access

  name        = "${var.bucket_name}-${each.value.environment}-${each.value.kind}"
  description = "Read, write and delete only ${each.value.kind} under ${each.value.environment}/ in ${var.bucket_name}."
  policy      = each.value.json
  tags        = var.tags
}

# Optional convenience. The role itself is created by whoever owns the
# workload's stack; this only attaches, so the two stacks never both manage a
# role.
resource "aws_iam_role_policy_attachment" "access" {
  for_each = local.role_attachments

  role       = each.value.role_name
  policy_arn = aws_iam_policy.access[each.value.environment].arn
}
