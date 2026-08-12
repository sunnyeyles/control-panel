# Validation rules, checked by breaking them.
#
# Every run here is expected to fail, and to fail at variable validation rather
# than at a resource — which is what makes the file runnable with no AWS
# credentials, no network and no state. `mock_provider` covers the rest.
#
# ⚠️ Note the `module` blocks: `expect_failures` can only name checkable objects
# in the module under test, and these validations live on the modules' own
# variables rather than the root's object wrappers.
#
# Only rules encoding a real invariant are covered; a validation that restates a
# type is not worth a test.

# ⚠️ Under a mock provider, `aws_iam_policy_document.json` is a placeholder
# string that the provider still validates as JSON at plan time. Left alone,
# every plan fails with "not a JSON object" alongside the failure the run is
# asserting, and `expect_failures` counts the extra error as a failed test.
#
# So the mock returns a structurally valid empty policy — enough for the
# plan-time check and no more. Asserting on rendered policy JSON would need
# `override_data` per address, which is not what this file is.
mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  # Same shape of problem for the boundary lookup in boundary.tf: a mocked `arn`
  # is a random string, and `aws_iam_role.permissions_boundary` is ARN-validated
  # at plan time.
  mock_data "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::000000000000:policy/control-panel-deploy-boundary"
    }
  }
}

# S3 bucket names are global and permanent. A name the API would reject is
# better caught here than three minutes into an apply.
run "rejects_invalid_bucket_name" {
  command = plan

  module {
    source = "./modules/user-storage"
  }

  variables {
    bucket_name  = "Not_A_Valid_Bucket"
    environments = ["prod"]
  }

  expect_failures = [var.bucket_name]
}

# The one that matters most in this file. Environment names are the leading key
# segment, and `packages/user-storage/src/keys.ts` enforces the same rule on the
# other side of the seam. A name containing a slash would make the IAM prefix
# scoping address a different place than the object keys do — a grant that reads
# as narrow and is not.
run "rejects_environment_name_with_slash" {
  command = plan

  module {
    source = "./modules/user-storage"
  }

  variables {
    bucket_name  = "control-panel-user-storage-test"
    environments = ["prod/eu"]
  }

  expect_failures = [var.environments]
}

# At least one environment, or nothing can reach the bucket at all — a stack
# that applies cleanly and is unusable.
run "rejects_empty_environments" {
  command = plan

  module {
    source = "./modules/user-storage"
  }

  variables {
    bucket_name  = "control-panel-user-storage-test"
    environments = []
  }

  expect_failures = [var.environments]
}

# Kind names become a key segment and an object tag value, and the tag is what
# the lifecycle rules filter on.
run "rejects_object_kind_name_with_uppercase" {
  command = plan

  module {
    source = "./modules/user-storage"
  }

  variables {
    bucket_name  = "control-panel-user-storage-test"
    environments = ["prod"]
    object_kinds = { Briefs = { expiration_days = 30 } }
  }

  expect_failures = [var.object_kinds]
}

# 900 seconds is Lambda's hard maximum. Above it the apply fails at the API with
# a less obvious message.
run "rejects_timeout_above_lambda_maximum" {
  command = plan

  module {
    source = "./modules/briefing-worker"
  }

  variables {
    function_name            = "briefing-worker"
    lambda_zip_path          = "./tests/fixtures/lambda.zip"
    alerts_topic_arn         = "arn:aws:sns:ap-southeast-2:000000000000:test"
    user_storage_bucket_name = "control-panel-user-storage-test"
    timeout                  = 901
  }

  expect_failures = [var.timeout]
}

# The alarms have to publish somewhere real. A non-ARN here would apply cleanly
# and deliver nothing.
run "rejects_non_arn_alerts_topic" {
  command = plan

  module {
    source = "./modules/briefing-worker"
  }

  variables {
    function_name            = "briefing-worker"
    lambda_zip_path          = "./tests/fixtures/lambda.zip"
    alerts_topic_arn         = "briefing-worker-alerts"
    user_storage_bucket_name = "control-panel-user-storage-test"
  }

  expect_failures = [var.alerts_topic_arn]
}

# The environment name is the leading segment of every object key the worker
# writes, and `assertSegment()` in `packages/user-storage/src/keys.ts` enforces
# the same rule on the other side. A name with a slash here would have the
# worker addressing a prefix the IAM grant does not scope to.
run "rejects_storage_environment_with_slash" {
  command = plan

  module {
    source = "./modules/briefing-worker"
  }

  variables {
    function_name            = "briefing-worker"
    lambda_zip_path          = "./tests/fixtures/lambda.zip"
    alerts_topic_arn         = "arn:aws:sns:ap-southeast-2:000000000000:test"
    user_storage_bucket_name = "control-panel-user-storage-test"
    user_storage_environment = "prod/eu"
  }

  expect_failures = [var.user_storage_environment]
}

# Alerting that silently switches itself off is the failure the alarms exist to
# catch, so a malformed address must break the apply rather than produce a
# subscription that can never confirm. Root-level: the address is the root's,
# because the topic is.
run "rejects_malformed_alert_email" {
  command = plan

  variables {
    alert_email = "not-an-email"

    user_storage = {
      bucket_name = "control-panel-user-storage-test"
    }

    briefing_worker = {
      lambda_zip_path = "./tests/fixtures/lambda.zip"
    }
  }

  expect_failures = [var.alert_email]
}
