# PocketBase Manager (`pb-manager`)

`pb-manager` is a comprehensive command-line interface (CLI) tool designed to streamline the deployment and management of multiple PocketBase instances on a single Linux server. It handles everything from installation and process management (PM2) to reverse proxy configuration (Nginx) and SSL automation (Certbot).

It supports **Debian-based** (Ubuntu, Debian), **RHEL-based** (Fedora, CentOS, Oracle Linux), and **Arch-based** Linux distributions.

**Version: 0.10.1**

## Key Features

- **Automated Instance Setup:** Downloads PocketBase, initializes data directories, and sets up system services in minutes.
- **Nginx Reverse Proxy Automation:**
  - Automatically generates Nginx virtual blocks with security headers.
  - Supports **HTTP/2**.
  - **Realtime Optimization:** Optional configuration to tune `/api/realtime` for Server-Sent Events (SSE), ensuring stable, long-lived connections.
  - Customizable `client_max_body_size` for large file uploads.
- **Security & Access Control:**
  - **IP Restrictions:** Limit access to your entire instance or just the Admin UI (`/_/`) to specific IP addresses.
  - **SSL/TLS:** Automates Let's Encrypt certificate acquisition and renewal via Certbot.
- **Process Management:** Built on top of **PM2** to ensure your instances are always running and restart automatically on boot or failure.
- **Maintenance Tools:**
  - `update-pocketbase`: Updates the PocketBase binary and restarts all instances.
  - `reset` / `remove`: Tools to wipe data or decommission instances cleanly.
  - `reset-admin`: Quickly reset the admin password for any instance.
- **Self-Updating:** The tool can update itself to the latest version from GitHub.

## Prerequisites

The installer handles most dependencies, but ensure you have:
- A supported Linux OS (Debian, Ubuntu, CentOS, Fedora, Arch, etc.)
- `root` or `sudo` access.
- Basic tools: `curl`, `git`.
- **Node.js v20.x+** (The installer will attempt to install this if missing).

## Installation

### Automated Install (Recommended)

Run the following command to download and run the installer script. This will set up Node.js, PM2, Nginx, Certbot, and `pb-manager` itself.

```bash
curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/Alpha-System-PBManager/main/install-pb-manager.sh | sudo bash
```

Once the installer finishes, run `sudo pb-manager setup` to download PocketBase binaries.

### Manual Installation

1.  **Install Dependencies:** Node.js 20+, PM2, Nginx, Certbot.
2.  **Download Script:**
    ```bash
    sudo mkdir -p /opt/pb-manager
    sudo curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/Alpha-System-PBManager/main/pb-manager.js -o /opt/pb-manager/pb-manager.js
    sudo chmod +x /opt/pb-manager/pb-manager.js
    ```
3.  **Install NPM Packages:**
    ```bash
    cd /opt/pb-manager
    sudo npm init -y
    sudo npm install commander inquirer@8 fs-extra nlcurl chalk unzipper shelljs
    ```
4.  **Create Symlink:**
    ```bash
    sudo ln -sfn /opt/pb-manager/pb-manager.js /usr/local/bin/pb-manager
    ```

## Usage

Run `pb-manager` with `sudo` to perform tasks.

```bash
sudo pb-manager <command> [options]
```

### Common Commands

| Command | Description |
| :--- | :--- |
| `add` (or `create`) | **Create a new instance.** Prompts for name, domain, port, and configuration options like HTTPS and Realtime Optimization. |
| `list` | List all managed instances, showing ports, domains, PM2 status, and SSL expiry. |
| `start <name>` | Start an instance (via PM2). Use `all` to start all. |
| `stop <name>` | Stop an instance. |
| `restart <name>` | Restart an instance. |
| `logs <name>` | View live logs for an instance. |
| `remove <name>` | Permanently remove an instance. You will be asked if you want to delete data. |
| `reset <name>` | Wipe an instance's data and start fresh (updates Config/PM2). |
| `reset-admin <name>`| Reset the admin email/password for an instance. |
| `update-ip-restrictions <name>` | Modify allowed IPs or lock down the Admin UI. |
| `renew-certificates` | Check and renew SSL certificates for all instances. |
| `update-pocketbase` | Update the global PocketBase binary and restart instances. |
| `update-pb-manager` | Update this CLI tool to the latest version. |
| `configure` | Set global CLI defaults (e.g., logging verbosity, default Certbot email). |

## Configuration Storage

- **Config Path:** `~/.pb-manager/` (usually `/root/.pb-manager/` if running with sudo).
- **Files:**
    - `instances.json`: Stores details of all managed instances.
    - `cli-config.json`: Global tool settings.
    - `ecosystem.config.js`: PM2 process configuration.

## Disclaimer

This tool is provided as-is, without warranty. The user assumes all responsibility. **Always back up critical data before performing operations like `remove` or `reset`.**
