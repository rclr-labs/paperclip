resource "random_id" "tunnel_secret" {
  byte_length = 32
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "paperclip" {
  account_id = var.account_id
  name       = "paperclip-${var.environment}"
  secret     = random_id.tunnel_secret.b64_std
  config_src = "cloudflare"
}

# Every hostname targets the router, so blue/green never edits the tunnel.
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "paperclip" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.paperclip.id

  config {
    ingress_rule {
      hostname = var.board_hostname
      service  = var.router_service
    }
    ingress_rule {
      hostname = var.machine_hostname
      service  = var.router_service
    }
    ingress_rule {
      service = "http_status:404"
    }
  }
}

# CNAME to <tunnel-id>.cfargotunnel.com (not an A record to the VM: the VM
# has no inbound exposure at all).
resource "cloudflare_record" "board" {
  zone_id = var.zone_id
  name    = var.board_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.paperclip.id}.cfargotunnel.com"
  proxied = true
}

resource "cloudflare_record" "machine" {
  zone_id = var.zone_id
  name    = var.machine_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.paperclip.id}.cfargotunnel.com"
  proxied = true
}
