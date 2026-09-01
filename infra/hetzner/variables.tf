variable "hcloud_token" {
  sensitive = true
}

variable "ssh_keys" {
  description = "SSH key names whose public halves live at ~/.ssh/<name>.pub on the machine running Terraform"
  type        = list(string)
  default     = ["id_ed25519"]
}

variable "location" {
  description = "Hetzner location for the relay host"
  type        = string
  default     = "fsn1"
}

variable "server_type" {
  description = "Server type for the relay host. The relay is off the hot path; the size mostly buys room for org-machine containers."
  type        = string
  default     = "cpx32"
}

variable "relay_domain" {
  description = "Public hostname the relay serves, e.g. relay.wp-nova.ai. Point its A record at relay_public_ip."
  type        = string
}

variable "source_git_url" {
  description = "Repository the relay host clones and runs the relay from"
  type        = string
  default     = "https://github.com/WP-Nova-GmbH/launchpad.git"
}
