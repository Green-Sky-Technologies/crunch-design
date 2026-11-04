variable "vercel_team_id" {
  type        = string
  description = "Vercel team id (team_...). Auth: VERCEL_API_TOKEN env var."
}

variable "neon_org_id" {
  type        = string
  description = "Neon organization id. Auth: NEON_API_KEY env var."
}

variable "github_repo" {
  type        = string
  description = "GitHub repo for the Vercel project, as owner/name (must be a personal repo owned by M-McCallum)."
  default     = "M-McCallum/CrunchDesign"
}

variable "neon_region" {
  type    = string
  default = "aws-us-east-1"
}

variable "vercel_region" {
  type        = string
  description = "Function region; keep close to the Neon region."
  default     = "iad1"
}

# ---- Secrets (pass via TF_VAR_* or an untracked *.tfvars file) ----

variable "clerk_publishable_key" {
  type = object({ production = string, preview = string })
}

variable "clerk_secret_key" {
  type      = object({ production = string, preview = string })
  sensitive = true
}

variable "clerk_webhook_signing_secret" {
  type      = object({ production = string, preview = string })
  sensitive = true
}

variable "credentials_master_keys" {
  type        = object({ production = string, preview = string })
  sensitive   = true
  description = "Output of `pnpm keygen` (id:base64[,id:base64]). Use different keys per environment."
}

variable "blob_read_write_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Vercel Blob store token (the provider can't create Blob stores; create one in the dashboard)."
}

variable "crunch_aws_principal_arn" {
  type        = string
  default     = ""
  description = "Our AWS principal that assumes customers' Bedrock roles (optional)."
}
