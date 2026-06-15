locals {
  name_suffix         = var.deployment_name
  use_modal_backend   = var.sandbox_provider == "modal"
  use_daytona_backend = var.sandbox_provider == "daytona"

  # URLs for cross-service configuration
  control_plane_host = "open-inspect-control-plane-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev"
  control_plane_url  = "https://${local.control_plane_host}"
  ws_url             = "wss://${local.control_plane_host}"

  github_bot_host = "open-inspect-github-bot-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev"
  github_bot_url  = "https://${local.github_bot_host}"

  cloudflare_web_app_custom_url          = trimsuffix(trimspace(var.cloudflare_web_app_url), "/")
  has_cloudflare_web_app_custom_domain   = local.cloudflare_web_app_custom_url != ""
  cloudflare_web_app_custom_host         = trimsuffix(trimprefix(local.cloudflare_web_app_custom_url, "https://"), "/")
  cloudflare_web_app_default_workers_url = "https://open-inspect-web-${local.name_suffix}.${var.cloudflare_worker_subdomain}.workers.dev"

  web_app_url = local.has_cloudflare_web_app_custom_domain ? local.cloudflare_web_app_custom_url : local.cloudflare_web_app_default_workers_url

  # Worker script paths (deterministic output locations)
  control_plane_script_path = "${var.project_root}/packages/control-plane/dist/index.js"
  slack_bot_script_path     = "${var.project_root}/packages/slack-bot/dist/index.js"
  linear_bot_script_path    = "${var.project_root}/packages/linear-bot/dist/index.js"
  github_bot_script_path    = "${var.project_root}/packages/github-bot/dist/index.js"
}
