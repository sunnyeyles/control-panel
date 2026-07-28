# Plan-level assertions for the user-storage stack.
#
# Everything here runs against a mocked provider, so no credentials, no network
# and no state are involved — which is the point: these are the checks that used
# to require an apply to a real account before anyone found out.
#
# Scope, stated honestly: assertions are on values this configuration derives.
# `aws_iam_policy_document` is a data source and its `json` is mocked, so what a
# rendered policy *says* is not asserted here. Doing that needs `override_data`
# per address and is a worthwhile separate pass.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  bucket_name  = "control-panel-user-storage-test"
  environments = ["prod"]
}

run "defaults" {
  command = plan

  module {
    source = "./modules/user-storage"
  }

  # The documented failure mode this exists to catch: a kind added to
  # `packages/user-storage/src/kinds.ts` with no matching entry here gets no
  # lifecycle rule at all. It does not error — it silently accumulates forever.
  # So assert the correspondence rather than the count.
  assert {
    condition = alltrue([
      for kind in keys(var.object_kinds) :
      contains(
        [for rule in aws_s3_bucket_lifecycle_configuration.user_storage.rule : rule.id],
        "retain-${kind}"
      )
    ])
    error_message = "Every object kind must have a retain-<kind> lifecycle rule; a kind without one is retained forever."
  }

  # Retention is tag-driven, not prefix-driven, because S3 lifecycle filters
  # match a literal prefix and `userId` sits between `environment` and `kind`.
  # A rule that filtered on a prefix would match nothing and look fine.
  assert {
    condition = alltrue([
      for rule in aws_s3_bucket_lifecycle_configuration.user_storage.rule :
      length(rule.filter[0].tag) == 1
      if startswith(rule.id, "retain-")
    ])
    error_message = "Per-kind retention must filter on the kind tag. A prefix filter cannot express 'every user's briefs'."
  }

  # `expiration_days = null` means never expire, and the absence of the block is
  # the guarantee — not an expiration set to something large. Resumes are
  # documents the user uploaded themselves; deleting one is data loss.
  assert {
    condition = length([
      for rule in aws_s3_bucket_lifecycle_configuration.user_storage.rule :
      rule if rule.id == "retain-resumes" && length(rule.expiration) > 0
    ]) == 0
    error_message = "resumes must have no expiration block at all, not a long one."
  }

  # One narrow policy per (environment, kind). This is what lets the worker be
  # granted briefs without also being granted a user's CV.
  assert {
    condition     = length(keys(aws_iam_policy.kind_access)) == length(var.environments) * length(keys(var.object_kinds))
    error_message = "There must be exactly one kind_access policy per environment and kind."
  }

  assert {
    condition     = contains(keys(aws_iam_policy.kind_access), "prod:briefs")
    error_message = "prod:briefs is the key briefing-worker.tf filters on; renaming it silently unattaches the worker's grant."
  }

  # A public object here is a personal-data breach, not a leaked summary. All
  # four flags, pinned at the bucket rather than trusted to account settings.
  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.user_storage.block_public_acls,
      aws_s3_bucket_public_access_block.user_storage.block_public_policy,
      aws_s3_bucket_public_access_block.user_storage.ignore_public_acls,
      aws_s3_bucket_public_access_block.user_storage.restrict_public_buckets,
    ])
    error_message = "All four public access block flags must be true."
  }

  # Versioning is the undo button, and the store's `delete` is only safe to
  # expose because of it.
  assert {
    condition     = aws_s3_bucket_versioning.user_storage.versioning_configuration[0].status == "Enabled"
    error_message = "Versioning must be enabled."
  }
}

# Null selects SSE-S3, which is free and needs no key policy. Setting a key must
# also grant the workloads kms:Decrypt, or every read 403s at runtime with a
# policy that looks correct.
run "customer_managed_key" {
  command = plan

  module {
    source = "./modules/user-storage"
  }

  variables {
    kms_key_arn = "arn:aws:kms:ap-southeast-2:000000000000:key/abcd"
  }

  # `rule` is a set of objects, not a list, so it has no addressable index — the
  # `for` expressions below are that, not indirection for its own sake.
  assert {
    condition = alltrue([
      for rule in aws_s3_bucket_server_side_encryption_configuration.user_storage.rule :
      alltrue([
        for sse in rule.apply_server_side_encryption_by_default :
        sse.sse_algorithm == "aws:kms"
      ])
    ])
    error_message = "A supplied KMS key must select aws:kms, not AES256."
  }

  # Only meaningful under KMS, where it collapses per-object key requests into
  # one per bucket-key period — a large cost difference at object-per-user-per-
  # day volumes.
  assert {
    condition = alltrue([
      for rule in aws_s3_bucket_server_side_encryption_configuration.user_storage.rule :
      rule.bucket_key_enabled
    ])
    error_message = "bucket_key_enabled must be on under a customer-managed key."
  }
}
