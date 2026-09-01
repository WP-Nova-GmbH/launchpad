terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.48"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

resource "hcloud_ssh_key" "default" {
  for_each = toset(var.ssh_keys)

  name       = each.value
  public_key = file("~/.ssh/${each.value}.pub")
}

# Everything the relay host needs to accept: SSH for operations, 80 for the
# ACME challenge and the HTTPS redirect, 443 for the relay itself. Postgres
# stays loopback-only and is not opened here.
resource "hcloud_firewall" "relay" {
  name = "launchpad-relay"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

# The whole hosted control plane on one machine: Postgres, the relay Node
# server, Caddy for TLS, and Docker for the org machines the relay provisions.
resource "hcloud_server" "relay_01" {
  name        = "launchpad-relay-01"
  image       = "ubuntu-24.04"
  server_type = var.server_type
  location    = var.location
  backups     = true

  ssh_keys     = [for ssh_key in hcloud_ssh_key.default : ssh_key.id]
  firewall_ids = [hcloud_firewall.relay.id]

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    relay_domain = var.relay_domain
  })

  labels = {
    managed_by  = "terraform"
    environment = "production"
    role        = "relay"
  }

  lifecycle {
    # cloud-init runs once at first boot; a later user_data edit would
    # otherwise replace the server, database included. Recreate deliberately
    # with `terraform apply -replace=hcloud_server.relay_01` when that is
    # really wanted.
    ignore_changes = [user_data]
  }
}

## Output
output "relay_public_ip" {
  value = hcloud_server.relay_01.ipv4_address
}

output "relay_url" {
  value = "https://${var.relay_domain}"
}
