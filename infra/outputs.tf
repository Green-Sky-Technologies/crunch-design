output "vercel_project_id" {
  value = vercel_project.web.id
}

output "neon_project_id" {
  value = neon_project.crunch.id
}

output "production_database_url" {
  value     = neon_project.crunch.connection_uri_pooler
  sensitive = true
}

output "staging_database_url" {
  value     = local.staging_database_url
  sensitive = true
}
