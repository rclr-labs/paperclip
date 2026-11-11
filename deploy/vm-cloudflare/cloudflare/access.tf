# Board: humans log in through Cloudflare Access, then Paperclip auth.
# Note: an invite link opened by someone outside this policy fails at Access
# ("That account does not have access") before it reaches Paperclip; add the
# invitee to allowed_emails/allowed_email_domains first.
resource "cloudflare_zero_trust_access_application" "board" {
  account_id                = var.account_id
  name                      = "Paperclip board (${var.environment})"
  domain                    = var.board_hostname
  type                      = "self_hosted"
  session_duration          = var.session_duration
  app_launcher_visible      = true
  auto_redirect_to_identity = false
}

resource "cloudflare_zero_trust_access_policy" "board_allow" {
  account_id     = var.account_id
  application_id = cloudflare_zero_trust_access_application.board.id
  name           = "allow members"
  decision       = "allow"
  precedence     = 1

  include {
    email        = var.allowed_emails
    email_domain = var.allowed_email_domains
  }
}

# Deploy automation (bluegreen.sh VERIFY_URL) authenticates with a service token.
resource "cloudflare_zero_trust_access_service_token" "deploy" {
  account_id = var.account_id
  name       = "paperclip-${var.environment}-deploy"
}

resource "cloudflare_zero_trust_access_policy" "board_deploy" {
  account_id     = var.account_id
  application_id = cloudflare_zero_trust_access_application.board.id
  name           = "deploy service token"
  decision       = "non_identity"
  precedence     = 2

  include {
    service_token = [cloudflare_zero_trust_access_service_token.deploy.id]
  }
}

# Machine hostname: sandboxes, remote runners and webhook senders cannot do
# an interactive Access login. Paperclip still authenticates every request
# (agent JWT / API key, runner token, provider signatures).
resource "cloudflare_zero_trust_access_application" "machine" {
  account_id       = var.account_id
  name             = "Paperclip machine API (${var.environment})"
  domain           = var.machine_hostname
  type             = "self_hosted"
  session_duration = var.session_duration
}

resource "cloudflare_zero_trust_access_policy" "machine" {
  account_id     = var.account_id
  application_id = cloudflare_zero_trust_access_application.machine.id
  name           = length(var.machine_allowed_cidrs) == 0 ? "bypass" : "egress allowlist"
  decision       = length(var.machine_allowed_cidrs) == 0 ? "bypass" : "non_identity"
  precedence     = 1

  include {
    everyone = length(var.machine_allowed_cidrs) == 0 ? true : null
    ip       = length(var.machine_allowed_cidrs) == 0 ? null : var.machine_allowed_cidrs
  }
}
