provider "vercel" {
  team = var.vercel_team_id
}

provider "neon" {}

# ---------------- Neon Postgres ----------------
# The default branch ("main") is production. "staging" branches from it.
# Per-PR preview branches come from the Neon <> Vercel integration (see infra/README.md).

resource "neon_project" "crunch" {
  name                      = "crunchdesign"
  org_id                    = var.neon_org_id
  region_id                 = var.neon_region
  pg_version                = 17
  history_retention_seconds = 86400

  branch {
    name          = "main"
    database_name = "crunch"
    role_name     = "crunch_app"
  }

  primary_compute {
    autoscaling_limit_min_cu = 0.25
    autoscaling_limit_max_cu = 2
    suspend_timeout_seconds  = 300
  }
}

resource "neon_branch" "staging" {
  project_id = neon_project.crunch.id
  parent_id  = neon_project.crunch.default_branch_id
  name       = "staging"
}

resource "neon_endpoint" "staging" {
  project_id               = neon_project.crunch.id
  branch_id                = neon_branch.staging.id
  type                     = "read_write"
  autoscaling_limit_min_cu = 0.25
  autoscaling_limit_max_cu = 1
  suspend_timeout_seconds  = 300
}

locals {
  staging_database_url = format(
    "postgres://%s:%s@%s/%s?sslmode=require",
    neon_project.crunch.database_user,
    neon_project.crunch.database_password,
    neon_endpoint.staging.host_pooling,
    neon_project.crunch.database_name,
  )
}

# ---------------- Vercel ----------------

resource "vercel_project" "web" {
  name                       = "crunchdesign"
  framework                  = "nextjs"
  root_directory             = "apps/web"
  serverless_function_region = var.vercel_region
  node_version               = "22.x"

  git_repository = {
    type              = "github"
    repo              = var.github_repo
    production_branch = "main"
  }

  vercel_authentication = {
    deployment_type = "standard_protection"
  }
}

resource "vercel_project_environment_variables" "web" {
  project_id = vercel_project.web.id
  variables = concat(
    [
      {
        key       = "DATABASE_URL"
        value     = neon_project.crunch.connection_uri_pooler
        target    = ["production"]
        sensitive = true
      },
      {
        # Preview deploys default to staging; the Neon integration overrides this per branch.
        key       = "DATABASE_URL"
        value     = local.staging_database_url
        target    = ["preview"]
        sensitive = true
      },
    ],
    flatten([
      for env in ["production", "preview"] : [
        { key = "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", value = var.clerk_publishable_key[env], target = [env], sensitive = false },
        { key = "CLERK_SECRET_KEY", value = var.clerk_secret_key[env], target = [env], sensitive = true },
        { key = "CLERK_WEBHOOK_SIGNING_SECRET", value = var.clerk_webhook_signing_secret[env], target = [env], sensitive = true },
        { key = "CREDENTIALS_MASTER_KEYS", value = var.credentials_master_keys[env], target = [env], sensitive = true },
      ]
    ]),
    var.blob_read_write_token == "" ? [] : [
      { key = "BLOB_READ_WRITE_TOKEN", value = var.blob_read_write_token, target = ["production", "preview"], sensitive = true },
    ],
    var.crunch_aws_principal_arn == "" ? [] : [
      { key = "CRUNCH_AWS_PRINCIPAL_ARN", value = var.crunch_aws_principal_arn, target = ["production", "preview"], sensitive = false },
    ],
  )
}
