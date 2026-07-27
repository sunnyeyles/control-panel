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
}
