# The shell only.
#
# There is no aws_secretsmanager_secret_version here on purpose, and adding one
# would undo the property this whole arrangement exists for: a value passed
# through Terraform appears in plan output, in the state file, and in the log of
# whatever ran the apply. The value is set once by hand, exactly as the Key
# Vault secret it replaces was, so the pipeline provisions a container it can
# never read.
#
#   aws secretsmanager put-secret-value \
#     --secret-id briefing-worker/openai-api-key \
#     --secret-string "sk-..."
#
# Terraform will not report drift when the value changes, because it does not
# track the value.
resource "aws_secretsmanager_secret" "openai" {
  name        = "${var.function_name}/openai-api-key"
  description = "OpenAI API key for the briefing worker. Set out-of-band; never written by Terraform."

  # Long enough to notice and undo a mistaken destroy, short enough that the
  # name is reusable within a sprint. Note the consequence for rollback: after
  # this window the value is gone and must come from the OpenAI dashboard.
  recovery_window_in_days = 7

  tags = var.tags

  # The value is the one thing here Terraform did not create and cannot put
  # back: after the recovery window it is gone, and the replacement comes from
  # the OpenAI dashboard rather than from an apply. Destroying this secret must
  # take an edit to this file.
  lifecycle {
    prevent_destroy = true
  }
}

# The Postgres connection string, on the same terms and for the same reason.
#
# A connection string carries a password, so it is exactly the kind of value the
# arrangement above exists to keep out of plan output, out of state, and out of
# the apply log. There is no aws_secretsmanager_secret_version here either.
#
# The **pooled** endpoint — `DATABASE_URL`, the PgBouncer one — because that is
# what a runtime consumer wants. Migrations need the direct endpoint and are not
# run by this function: every cold start would race every other one for a schema
# it does not need.
#
#   aws secretsmanager put-secret-value \
#     --secret-id briefing-worker/database-url \
#     --secret-string "postgresql://…-pooler.…neon.tech/neondb?sslmode=require"
#
# Rotation is Neon's to do and ours to mirror: rotating there means putting the
# new string here, and nothing in Terraform notices either way.
resource "aws_secretsmanager_secret" "database" {
  name        = "${var.function_name}/database-url"
  description = "Pooled Postgres connection string for the briefing worker. Set out-of-band; never written by Terraform."

  recovery_window_in_days = 7

  tags = var.tags

  # Unlike the OpenAI key, this value is recoverable from the Neon console — but
  # destroying it still takes the worker off the database with no warning, and
  # the name is not reusable until the recovery window elapses.
  lifecycle {
    prevent_destroy = true
  }
}

# The Apify API token, on the same terms and for the same reason.
#
# The scout's SEEK search tool reads it. Without it a run reaches the model,
# spends a turn discovering it cannot search, and fails — which is the intended
# outcome: a brief assembled without a single successful search would cite
# postings that were never looked up.
#
#   aws secretsmanager put-secret-value \
#     --secret-id briefing-worker/apify-token \
#     --secret-string "apify_api_..."
resource "aws_secretsmanager_secret" "apify" {
  name        = "${var.function_name}/apify-token"
  description = "Apify API token for the briefing worker's SEEK search tool. Set out-of-band; never written by Terraform."

  recovery_window_in_days = 7

  tags = var.tags

  # Recoverable from the Apify console, unlike the OpenAI key, but destroying
  # it still stops every briefing with no warning and holds the name for the
  # length of the recovery window.
  lifecycle {
    prevent_destroy = true
  }
}

# Langfuse uses a public key to identify the project and a secret key to submit
# traces. Neither belongs in Lambda configuration, Terraform state, or plans.
#
#   aws secretsmanager put-secret-value \
#     --secret-id briefing-worker/langfuse-public-key \
#     --secret-string "pk-lf-..."
#
#   aws secretsmanager put-secret-value \
#     --secret-id briefing-worker/langfuse-secret-key \
#     --secret-string "sk-lf-..."
resource "aws_secretsmanager_secret" "langfuse_public" {
  name        = "${var.function_name}/langfuse-public-key"
  description = "Langfuse public API key for the briefing worker. Set out-of-band; never written by Terraform."

  recovery_window_in_days = 7

  tags = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret" "langfuse_secret" {
  name        = "${var.function_name}/langfuse-secret-key"
  description = "Langfuse secret API key for the briefing worker. Set out-of-band; never written by Terraform."

  recovery_window_in_days = 7

  tags = var.tags

  lifecycle {
    prevent_destroy = true
  }
}
