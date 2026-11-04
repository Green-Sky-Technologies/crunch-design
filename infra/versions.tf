terraform {
  required_version = ">= 1.8"
  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 3.0"
    }
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.9"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
