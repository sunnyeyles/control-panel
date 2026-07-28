# The permissions boundary every role in this root must carry.
#
# Created by `infra/aws/bootstrap` — see `bootstrap/boundary.tf` for what it caps
# and why. It is looked up by name rather than read out of bootstrap's state,
# because that state is a local file on whichever laptop applied it and is
# gitignored; a `terraform_remote_state` data source pointing at it would work
# for exactly one person.
#
# The coupling this leaves is a string. If the boundary is renamed in bootstrap,
# this lookup fails with "no matching IAM policy found" on the next plan — noisy,
# immediate, and pointing at the right file, which is the failure mode to want.
#
# If this errors on a first-ever plan, bootstrap has not been applied. That is a
# prerequisite, not a bug: `bootstrap/README.md` covers it.
data "aws_iam_policy" "workload_boundary" {
  name = "control-panel-deploy-boundary"
}
