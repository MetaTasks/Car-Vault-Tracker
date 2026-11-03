# LOT / KEEP — Car Inventory

LOT / KEEP is a mobile-friendly vehicle-yard inventory app. It stores Swedish registration numbers, marks vehicles as on or off site, and tracks whether their keys are in the locked vault. Plate scanning uses the browser camera and OCR; manual registration entry is also available.

This guide covers a self-hosted Ubuntu server using PostgreSQL, Nginx, and systemd.

## Important: access control

The app currently has **no built-in sign-in**. Anyone who can reach it can view, add, update, and remove inventory records. Do not expose it publicly with real fleet data unless you protect it with a VPN, firewall/IP restriction, or an authenticated HTTPS reverse proxy. Do not expose PostgreSQL port `5432` or API port `8080` to the internet.

Phone camera access requires HTTPS (except on `localhost`). Configure a trusted TLS certificate before relying on plate scanning from phones. Manual entry remains available if camera access is blocked.

Plate OCR runs in the browser and does not send the captured image to the API. Tesseract.js loads its worker and OCR engine from `cdn.jsdelivr.net` and English language data from `tessdata.projectnaptha.com` by default, so the device's browser needs outbound HTTPS access to those assets. If access is blocked, manual entry still works. For fully offline hosting, serve the Tesseract assets locally and configure the worker paths in `artifacts/car-inventory/src/App.tsx`.

## How the self-hosted setup works

- Nginx serves the built frontend from `artifacts/car-inventory/dist/public`.
- Nginx forwards `/api/` requests to the Express API on port `8080`.
- PostgreSQL stores vehicle and key-status records.
- The web frontend is static after it is built; it does not need a separate Node process.

## Requirements

- Ubuntu 22.04 or 24.04
- Node.js 24
- pnpm 10 (the commands below use pnpm 10.26.1)
- PostgreSQL
- Nginx
- A domain name pointing at the server if you need phone camera access over the internet

## 1. Install system packages

```bash
sudo apt update
sudo apt install -y git curl ca-certificates nginx postgresql

# Install Node.js 24 from NodeSource.
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

# Enable Corepack and activate the pnpm version used by this workspace.
sudo corepack enable
sudo corepack prepare pnpm@10.26.1 --activate

node --version
pnpm --version
```

The Node version should report `v24.x`; pnpm should report `10.26.1`.

## 2. Create a service account and get the source

Replace the example Git URL below with the URL for this project. For a private repository, configure a read-only deploy key for the service account rather than putting an access token directly in the command.

```bash
sudo useradd --system --user-group --create-home \
  --home-dir /var/lib/carinventory \
  --shell /usr/sbin/nologin carinventory

sudo install -d -o carinventory -g carinventory -m 0755 /opt/car-inventory
sudo -u carinventory git clone \
  "https://YOUR_GIT_HOST/OWNER/REPOSITORY.git" \
  /opt/car-inventory

sudo -u carinventory -H bash -lc \
  'cd /opt/car-inventory && pnpm install --frozen-lockfile'
```

If the repository is already present, update it instead of cloning it again.

## 3. Create the PostgreSQL database

Generate a password containing URL-safe characters:

```bash
openssl rand -hex 32
```

Copy the generated value, then create the database and app user:

```bash
sudo -u postgres psql
```

At the PostgreSQL prompt, replace the example password with the value you generated:

```sql
CREATE USER car_inventory_app WITH PASSWORD 'PASTE_GENERATED_PASSWORD';
CREATE DATABASE car_inventory OWNER car_inventory_app;
\q
```

Create a protected environment file for the API service:

```bash
sudo install -d -o root -g carinventory -m 0750 /etc/car-inventory
sudoedit /etc/car-inventory/app.env
```

Put this line in the file, using the same password:

```text
DATABASE_URL=postgresql://car_inventory_app:PASTE_GENERATED_PASSWORD@127.0.0.1:5432/car_inventory
```

Then restrict access to the file:

```bash
sudo chown root:carinventory /etc/car-inventory/app.env
sudo chmod 640 /etc/car-inventory/app.env
```

Keep this file out of Git and backups that are accessible to untrusted users.

## 4. Create the database tables and build the app

The schema command creates or updates the tables in the database named by `DATABASE_URL`.

```bash
sudo -u carinventory -H bash -lc \
  'cd /opt/car-inventory && set -a && . /etc/car-inventory/app.env && set +a && pnpm --filter @workspace/db run push'
```

Build the API and static frontend:

```bash
sudo -u carinventory -H bash -lc \
  'cd /opt/car-inventory && NODE_ENV=production pnpm --filter @workspace/api-server run build && NODE_ENV=production PORT=24941 BASE_PATH=/ pnpm --filter @workspace/car-inventory run build'
```

The frontend build uses `PORT` and `BASE_PATH` while loading the Vite configuration. For this root-mounted deployment, keep `BASE_PATH=/`.

## 5. Run the API with systemd

Create the service unit:

```bash
sudoedit /etc/systemd/system/car-inventory-api.service
```

Use this content:

```ini
[Unit]
Description=LOT / KEEP Car Inventory API
After=network-online.target postgresql.service
Wants=network-online.target postgresql.service

[Service]
Type=simple
User=carinventory
Group=carinventory
WorkingDirectory=/opt/car-inventory
EnvironmentFile=/etc/car-inventory/app.env
Environment=NODE_ENV=production
Environment=PORT=8080
ExecStart=/usr/bin/node --enable-source-maps artifacts/api-server/dist/index.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable it and check that the API starts:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now car-inventory-api
sudo systemctl status car-inventory-api
curl -fsS http://127.0.0.1:8080/api/healthz
```

The health check should return `{"status":"ok"}`. View API logs with:

```bash
sudo journalctl -u car-inventory-api -n 100 --no-pager
```

## 6. Configure Nginx

Replace `inventory.example.com` with your domain. If using only a private LAN, use the host name or address your staff will access.

```bash
sudoedit /etc/nginx/sites-available/car-inventory
```

Add:

```nginx
server {
    listen 80;
    server_name inventory.example.com;

    root /opt/car-inventory/artifacts/car-inventory/dist/public;
    index index.html;

    location /api/ {
        # Do not add a trailing slash to proxy_pass: the API expects /api/...
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Enable the site and validate the Nginx configuration:

```bash
sudo ln -s /etc/nginx/sites-available/car-inventory \
  /etc/nginx/sites-enabled/car-inventory
sudo nginx -t
sudo systemctl reload nginx
```

### Add HTTPS for phone camera access

Point your domain's DNS record at the server, then install a Let's Encrypt certificate:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d inventory.example.com
```

If this is an internet-facing server, allow only the ports you need. For example, allow SSH and Nginx HTTPS/HTTP, but do not open ports `5432` or `8080`:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

### Optional: add a shared Nginx password gate

If you do not have a VPN or another authenticated proxy, Nginx Basic Authentication is a minimal shared-password barrier. It is not a replacement for per-staff accounts or an audit trail, and it must be used over HTTPS.

```bash
sudo apt install -y apache2-utils
sudo htpasswd -c /etc/nginx/.car-inventory.htpasswd yardstaff
sudo chown root:www-data /etc/nginx/.car-inventory.htpasswd
sudo chmod 640 /etc/nginx/.car-inventory.htpasswd
```

Add these directives inside the Nginx `server` block so both the app and API require the password:

```nginx
auth_basic "Car Inventory";
auth_basic_user_file /etc/nginx/.car-inventory.htpasswd;
```

Then validate and reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 7. Open the app

Visit `https://inventory.example.com` (or your configured private host). Import a registration list, or use **Scan a plate** on a phone and allow camera access.

## Updating the installation

Back up the database before applying schema changes. Then pull the new code, install locked dependencies, apply the schema, rebuild, and restart the API:

```bash
sudo -u postgres pg_dump -Fc car_inventory \
  | sudo tee "/root/car_inventory_$(date +%F).dump" >/dev/null

sudo -u carinventory -H bash -lc \
  'cd /opt/car-inventory && git pull --ff-only && pnpm install --frozen-lockfile'

sudo -u carinventory -H bash -lc \
  'cd /opt/car-inventory && set -a && . /etc/car-inventory/app.env && set +a && pnpm --filter @workspace/db run push'

sudo -u carinventory -H bash -lc \
  'cd /opt/car-inventory && NODE_ENV=production pnpm --filter @workspace/api-server run build && NODE_ENV=production PORT=24941 BASE_PATH=/ pnpm --filter @workspace/car-inventory run build'

sudo systemctl restart car-inventory-api
sudo systemctl reload nginx
```

## Troubleshooting

- **Nginx shows `502 Bad Gateway`:** Check `sudo systemctl status car-inventory-api` and `sudo journalctl -u car-inventory-api -n 100 --no-pager`.
- **API reports a database error:** Check PostgreSQL is running and verify the `DATABASE_URL` in `/etc/car-inventory/app.env`.
- **The phone cannot open the camera:** Use HTTPS, grant camera permission to the browser, and retry. Manual plate entry is available as a fallback.
- **The site loads but API calls fail:** Confirm Nginx proxies `/api/` to port `8080` without stripping the `/api` prefix.
