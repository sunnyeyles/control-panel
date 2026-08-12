# The permissions boundary every role in this root must carry.
#
# Created by `infra/aws/bootstrap` — see `bootstrap/boundary.tf` for what it caps
# and why. Looked up by name rather than through `terraform_remote_state`,
# because bootstrap's state is a gitignored local file on one laptop.
#
# ⚠️ The coupling that leaves is a string: rename the boundary in bootstrap and
# this fails with "no matching IAM policy found" on the next plan. An error on a
# first-ever plan means bootstrap has not been applied — a prerequisite, covered
# in `bootstrap/README.md`.
data "aws_iam_policy" "workload_boundary" {
  name = "control-panel-deploy-boundary"
}
