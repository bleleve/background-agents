variable "modal_token_id" {
  description = "Modal API token ID"
  type        = string
  sensitive   = true
}

variable "modal_token_secret" {
  description = "Modal API token secret"
  type        = string
  sensitive   = true
}

variable "app_name" {
  description = "Display name shown in the web UI tab title, sidebar logo, sign-in page, bot messages (Slack, Linear), PR body footer, and outbound HTTP User-Agent headers."
  type        = string
  default     = "Reef"
}

variable "workspace" {
  description = "Modal workspace name (used in endpoint URLs)"
  type        = string
}

variable "deploy_path" {
  description = "Path to the Modal app source code"
  type        = string
}

variable "deploy_module" {
  description = "Python module to deploy (e.g., 'deploy' or 'src')"
  type        = string
  default     = "deploy"
}

variable "source_hash" {
  description = "Hash of source files to trigger redeployment on changes"
  type        = string
  default     = ""
}

variable "secrets" {
  description = "List of Modal secrets to create"
  type = list(object({
    name   = string
    values = map(string)
  }))
  default   = []
  sensitive = true
}

variable "environment" {
  description = "Modal environment name (e.g., 'dev01'). Empty string uses the default environment."
  type        = string
  default     = ""
}

variable "fetch_app_info" {
  description = "Whether to fetch app info after deployment"
  type        = bool
  default     = false
}
