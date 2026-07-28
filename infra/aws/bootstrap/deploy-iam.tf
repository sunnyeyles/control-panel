# The IAM half of the deploy role's permissions, kept in its own file because it
# is the half with the sharp edges.
#
# Read boundary.tf first: it explains why `CreateRole` + `AttachRolePolicy` +
# `PassRole` compose into administrator, and what the boundary caps. This file is
# the other half — the conditions that make the boundary unavoidable rather than
# merely available, plus the resource scoping that keeps all of it inside this
# project's own roles and policies.
#
# Three things are doing the work:
#
#   1. Every statement is scoped to `var.managed_role_arn_patterns` or
#      `var.managed_policy_arn_patterns` rather than `*`, so the deploy role
#      cannot touch a role or policy belonging to something else in the account.
#   2. Anything that creates a role, or changes what a role can do, is
#      conditioned on the boundary being attached.
#   3. Removing a boundary is denied outright, or step 2 would be one API call
#      from being irrelevant.

locals {
  role_prefix   = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role"
  policy_prefix = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy"

  # Defaulted here rather than on the variables, because a variable default
  # cannot reference a data source and these need the account id. Overriding
  # either variable replaces the list wholesale.
  managed_role_arn_patterns = coalesce(var.managed_role_arn_patterns, [
    # The briefing worker's execution and scheduler roles.
    "${local.role_prefix}/briefing-worker-*",
    # Anything a future stack names after the project.
    "${local.role_prefix}/control-panel-*",
  ])

  managed_policy_arn_patterns = coalesce(var.managed_policy_arn_patterns, [
    # Covers the user-storage grants, which are named after the bucket:
    # `control-panel-user-storage-<account>-prod-briefs` and siblings.
    "${local.policy_prefix}/control-panel-*",
  ])

  # `iam:PermissionsBoundary` is only a valid condition key on the subset of IAM
  # actions that create or alter a principal's permissions — CreateRole,
  # Put/DeleteRolePolicy, Attach/DetachRolePolicy, PutRolePermissionsBoundary.
  # On any other action the key is simply absent from the request, and a
  # StringEquals against an absent key does not match, which would silently deny
  # the action. That is why role *administration* below (delete, tag, read) sits
  # in an unconditioned statement rather than being folded in here.
  boundary_arn = aws_iam_policy.workload_boundary.arn
}

data "aws_iam_policy_document" "deploy_iam" {
  # Reading. No condition is possible or needed — these change nothing.
  statement {
    sid = "ReadProjectRoles"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListRoleTags",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = local.managed_role_arn_patterns
  }

  # Role administration that cannot grant permissions: naming, tagging, deleting,
  # and editing who may assume the role.
  #
  # `UpdateAssumeRolePolicy` is the one to think twice about — it decides *who*
  # can assume a role rather than what the role can do. It is safe here because
  # the boundary caps what any of these roles can do in the first place, so
  # widening the trust policy on one hands over a capped set of permissions.
  statement {
    sid = "AdministerProjectRoles"
    actions = [
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
    ]
    resources = local.managed_role_arn_patterns
  }

  # Creating a role at all, and setting the boundary on it. Conditioned, so a
  # role created by this pipeline is always capped — there is no "create it now,
  # bound it later" path.
  statement {
    sid = "CreateOnlyBoundedRoles"
    actions = [
      "iam:CreateRole",
      "iam:PutRolePermissionsBoundary",
    ]
    resources = local.managed_role_arn_patterns

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary_arn]
    }
  }

  # Inline policies on those roles. Same condition: the target must already carry
  # the boundary, so an unbounded role cannot be handed permissions even if one
  # somehow existed.
  statement {
    sid = "WriteInlinePoliciesOnBoundedRoles"
    actions = [
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
    ]
    resources = local.managed_role_arn_patterns

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary_arn]
    }
  }

  # Attaching managed policies — the step that would otherwise attach
  # `AdministratorAccess`. Two conditions, and both must hold: the role must be
  # bounded, *and* the policy must be one of this project's own.
  #
  # `iam:PolicyARN` is what closes the AWS-managed-policy path. Without it the
  # boundary alone would still cap the result, but the intent of an attach would
  # be unreviewable.
  statement {
    sid = "AttachOnlyProjectPolicies"
    actions = [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = local.managed_role_arn_patterns

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary_arn]
    }

    condition {
      test     = "ArnLike"
      variable = "iam:PolicyARN"
      values   = concat(local.managed_policy_arn_patterns, [local.boundary_arn])
    }
  }

  # The policies themselves — the per-environment and per-kind grants the
  # user-storage module creates. Scoped by name pattern, so the pipeline cannot
  # edit a policy some other system in this account owns.
  statement {
    sid = "ManageProjectPolicies"
    actions = [
      "iam:CreatePolicy",
      "iam:DeletePolicy",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:ListPolicyTags",
      "iam:TagPolicy",
      "iam:UntagPolicy",
      "iam:ListEntitiesForPolicy",
    ]
    resources = local.managed_policy_arn_patterns
  }

  # Finding the boundary policy by name, which is how `infra/aws/boundary.tf`
  # resolves it — it cannot read this root's state, because that state is a local
  # file on one laptop.
  #
  # The provider implements a name lookup as "enumerate the account's policies
  # and match", so the call is `iam:ListPolicies`, and AWS offers no
  # resource-level scoping for it: the request is authorized against the policy
  # *path*, not against any one policy, which is why the error names
  # `resource: policy path /`. `*` is the only value this can take.
  #
  # Read-only, and it widens nothing that matters: it returns policy metadata and
  # confers no ability to attach, edit or pass anything. Every statement above
  # that *changes* a policy is still scoped to `control-panel-*`.
  statement {
    sid       = "ListPoliciesToResolveTheBoundaryByName"
    actions   = ["iam:ListPolicies"]
    resources = ["*"]
  }

  # Handing a role to a service. Previously `*`, which meant the pipeline could
  # give any role in the account to a Lambda it created.
  statement {
    sid       = "PassOnlyProjectRoles"
    actions   = ["iam:PassRole"]
    resources = local.managed_role_arn_patterns
  }

  # Without this, everything above is one API call from irrelevant: strip the
  # boundary from a role, and the conditions that reference it stop matching in
  # the direction that matters.
  #
  # Recovering a role whose boundary was removed takes a human with admin, which
  # is the correct cost.
  statement {
    sid       = "NeverRemoveAPermissionsBoundary"
    effect    = "Deny"
    actions   = ["iam:DeleteRolePermissionsBoundary"]
    resources = ["*"]
  }
}
