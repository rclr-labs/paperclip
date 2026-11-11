output "tunnel_id" {
  value = cloudflare_zero_trust_tunnel_cloudflared.paperclip.id
}

# Goes to CLOUDFLARE_TUNNEL_TOKEN (compose) or cloudflared.env (quadlet).
output "tunnel_token" {
  value     = cloudflare_zero_trust_tunnel_cloudflared.paperclip.tunnel_token
  sensitive = true
}

output "deploy_service_token_client_id" {
  value = cloudflare_zero_trust_access_service_token.deploy.client_id
}

output "deploy_service_token_client_secret" {
  value     = cloudflare_zero_trust_access_service_token.deploy.client_secret
  sensitive = true
}
