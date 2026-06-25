# Fail the plan when no access control is configured. Uses terraform_data with a
# precondition so this is a hard error, not an advisory check-block warning.
resource "terraform_data" "access_control_gate" {
  lifecycle {
    precondition {
      condition = (
        var.unsafe_allow_all_users ||
        length([for item in split(",", var.allowed_users) : trimspace(item) if trimspace(item) != ""]) > 0 ||
        length([for item in split(",", var.allowed_email_domains) : trimspace(item) if trimspace(item) != ""]) > 0 ||
        length([for item in split(",", var.allowed_emails) : trimspace(item) if trimspace(item) != ""]) > 0 ||
        length([for item in split(",", var.allowed_github_orgs) : trimspace(item) if trimspace(item) != ""]) > 0
      )
      error_message = "At least one access control allowlist must be configured. Set allowed_users, allowed_email_domains, allowed_emails, or allowed_github_orgs, or set unsafe_allow_all_users = true to explicitly allow all authenticated users."
    }
  }
}
