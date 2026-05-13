# Anot — Amazon Web Services (AWS) deployment (complete guide)

Deploy the **Node API** on **EC2** (Ubuntu-style) behind **Nginx**, with **PostgreSQL** on **RDS** or on the same instance. Optionally serve the **built React app** as static files from the same or another Nginx `server` block.

**Security:** Replace every `CHANGE_ME_*` and `YOUR_*` placeholder. Never commit production `.env` files, `JWT_SECRET`, or database passwords.

---

## Table of contents

1. [Architecture](#1-architecture)  
2. [What you must prepare](#2-what-you-must-prepare)  
3. [AWS resources](#3-aws-resources)  
4. [Build the frontend (your laptop or CI)](#4-build-the-frontend-your-laptop-or-ci)  
5. [EC2: connect and install packages](#5-ec2-connect-and-install-packages)  
6. [PostgreSQL (RDS or on EC2)](#6-postgresql-rds-or-on-ec2)  
7. [Deploy backend code](#7-deploy-backend-code)  
8. [Backend `.env` (production)](#8-backend-env-production)  
9. [Apply SQL migrations](#9-apply-sql-migrations)  
10. [Smoke test the API](#10-smoke-test-the-api)  
11. [PM2 process manager](#11-pm2-process-manager)  
12. [Nginx: static UI + API reverse proxy](#12-nginx-static-ui--api-reverse-proxy)  
13. [Upload frontend `dist/`](#13-upload-frontend-dist)  
14. [TLS (Let’s Encrypt)](#14-tls-lets-encrypt)  
15. [Uploads directory](#15-uploads-directory)  
16. [Post-deploy checklist](#16-post-deploy-checklist)  
17. [Operations commands](#17-operations-commands)  
18. [Troubleshooting (AWS / VPS)](#18-troubleshooting-aws--vps)

---

## 1) Architecture

| Layer | Technology | Notes |
|-------|------------|--------|
| **Compute** | EC2 (Ubuntu 22.04 LTS AMI typical) | Elastic IP recommended |
| **API** | Node.js + Express, port **5000** locally | Behind Nginx `proxy_pass` |
| **Process manager** | PM2 | Restarts, logs, boot persistence |
| **Reverse proxy / static** | Nginx | TLS termination, `try_files` for SPA |
| **Database** | Amazon RDS for PostgreSQL (recommended) or Postgres on EC2 | App user should not be `postgres` superuser in prod |

---

## 2) What you must prepare

| Item | Placeholder | Notes |
|------|-------------|--------|
| SSH key | `YOUR_KEY.pem` | EC2 key pair |
| SSH user | `ubuntu` | **Amazon Linux** often uses **`ec2-user`** |
| Server | `YOUR_EC2_PUBLIC_IP` or DNS | |
| Domain (optional) | `yourdomain.com`, `api.yourdomain.com` | **A** records → Elastic IP |
| DB password | `CHANGE_ME_DB_PASSWORD` | Long random |
| JWT secret | run `openssl rand -hex 32` | At least 16 chars; 32+ hex in prod |

```bash
openssl rand -hex 32
```

---

## 3) AWS resources

### EC2 security group (inbound)

| Port | Purpose | Notes |
|------|---------|--------|
| **22** | SSH | Restrict to **your IP** |
| **80** | HTTP | For Certbot / redirect to HTTPS |
| **443** | HTTPS | Public web + API hostname |
| **5432** | PostgreSQL | **Avoid** public 5432 unless required; prefer RDS in a **private** subnet with SG allowing **only** the EC2 security group |

### RDS (recommended)

- Engine: **PostgreSQL**  
- Create database + user for the app  
- Note the **endpoint**, **port**, **database name**, **user**, **password** for `DATABASE_URL`

### DNS (optional)

- **`A`** `api.yourdomain.com` → Elastic IP  
- **`A`** `yourdomain.com` / `www` → same or different target if UI is separate

---

## 4) Build the frontend (your laptop or CI)

Point the UI at your **public** API (include **`/api`**):

**Windows:**

```powershell
cd anot-frontend-main\anot-frontend-main
Set-Content -Path .env.production -Value "VITE_API_URL=https://api.yourdomain.com/api"
npm ci
npm run build
```

**Linux / macOS:**

```bash
cd anot-frontend-main/anot-frontend-main
printf '%s\n' 'VITE_API_URL=https://api.yourdomain.com/api' > .env.production
npm ci && npm run build
```

Output: **`dist/`** — upload **contents** of this folder to the server (see [section 13](#13-upload-frontend-dist)).

---

## 5) EC2: connect and install packages

```bash
ssh -i YOUR_KEY.pem ubuntu@YOUR_EC2_PUBLIC_IP
```

**Ubuntu — update and install Node 20, Nginx, Git:**

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx git build-essential
node -v
npm -v
```

---

## 6) PostgreSQL (RDS or on EC2)

### Option A — RDS (recommended)

Create instance + DB + user in AWS Console. Build **`DATABASE_URL`**:

```text
postgresql://anot_app:CHANGE_ME_DB_PASSWORD@your-rds-endpoint.region.rds.amazonaws.com:5432/anot
```

Ensure the **RDS security group** allows inbound **5432** from the **EC2 security group** (not from `0.0.0.0/0` unless you have no other choice).

### Option B — PostgreSQL on the same EC2

```bash
sudo apt install -y postgresql postgresql-contrib
sudo -u postgres psql -c "CREATE USER anot_app WITH PASSWORD 'CHANGE_ME_DB_PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE anot OWNER anot_app;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE anot TO anot_app;"
```

---

## 7) Deploy backend code

```bash
sudo mkdir -p /opt/anot
sudo chown -R ubuntu:ubuntu /opt/anot
cd /opt/anot
git clone https://github.com/YOUR_ORG/anot.git repo
cd repo/anot-backend-main/anot-backend-main
npm ci --omit=dev
```

If you deploy without `git`, use `scp`/`rsync` to copy the same folder structure.

---

## 8) Backend `.env` (production)

**Path:** `/opt/anot/repo/anot-backend-main/anot-backend-main/.env`

```bash
cd /opt/anot/repo/anot-backend-main/anot-backend-main
chmod 600 .env
nano .env
```

### Example — RDS `DATABASE_URL`

```env
NODE_ENV=production
PORT=5000
TRUST_PROXY=1

DATABASE_URL=postgresql://anot_app:CHANGE_ME_DB_PASSWORD@your-rds-endpoint.region.rds.amazonaws.com:5432/anot

JWT_SECRET=PASTE_OPENSSL_RAND_HEX_OUTPUT_HERE

CORS_ORIGINS=https://yourdomain.com,https://www.yourdomain.com,https://app.yourdomain.com
```

### Example — Postgres on same EC2 (`DB_*`)

```env
NODE_ENV=production
PORT=5000
TRUST_PROXY=1
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=anot
DB_USER=anot_app
DB_PASSWORD=CHANGE_ME_DB_PASSWORD
JWT_SECRET=PASTE_OPENSSL_RAND_HEX_OUTPUT_HERE
CORS_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

**`CORS_ORIGINS`:** comma-separated, **exact** origins (scheme + host), **no trailing slash**. Must include every browser origin that loads the SPA.

Optional: `GROQ_API_KEY`, `SETTINGS_ENCRYPTION_KEY`, `DATABASE_SSL_INSECURE` (see `src/config/db.js`).

---

## 9) Apply SQL migrations

SQL files:

```text
anot-backend-main/anot-backend-main/migrations/
```

From a machine that can reach the DB:

```bash
psql "postgresql://anot_app:PASSWORD@HOST:5432/anot" -f migrations/20260210_visits_visit_type_add_other.sql
```

Apply **all** migration files in order. If the repo ships a npm script for a specific migration:

```bash
cd /opt/anot/repo/anot-backend-main/anot-backend-main
npm run migrate:visit-type-other
```

---

## 10) Smoke test the API

```bash
cd /opt/anot/repo/anot-backend-main/anot-backend-main
node src/server.js
```

Confirm logs show DB connected and `Anot server running on http://127.0.0.1:5000`. Press **Ctrl+C** to stop before PM2.

---

## 11) PM2 process manager

```bash
sudo npm install -g pm2
cd /opt/anot/repo/anot-backend-main/anot-backend-main
pm2 start src/server.js --name anot-api
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

Run the **`sudo env PATH=...`** line PM2 prints so the API restarts on reboot.

| Action | Command |
|--------|---------|
| Logs | `pm2 logs anot-api` |
| Restart | `pm2 restart anot-api` |
| List | `pm2 status` |

---

## 12) Nginx: static UI + API reverse proxy

```bash
sudo nano /etc/nginx/sites-available/anot
```

**Example** — UI on `yourdomain.com`, API on `api.yourdomain.com`:

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    root /var/www/anot-frontend;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}

server {
    listen 80;
    server_name api.yourdomain.com;

    location /api/ {
        proxy_pass http://127.0.0.1:5000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 100M;
    }
}
```

Enable site and reload:

```bash
sudo ln -sf /etc/nginx/sites-available/anot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 13) Upload frontend `dist/`

**On your laptop** (after `npm run build`):

```bash
scp -i YOUR_KEY.pem -r anot-frontend-main/anot-frontend-main/dist/* ubuntu@YOUR_EC2_PUBLIC_IP:/tmp/anotfe/
```

**On the server:**

```bash
sudo mkdir -p /var/www/anot-frontend
sudo rsync -a /tmp/anotfe/ /var/www/anot-frontend/
```

---

## 14) TLS (Let’s Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com -d api.yourdomain.com
```

Then:

1. Set **`CORS_ORIGINS`** and **`VITE_API_URL`** to **https** URLs.  
2. Rebuild frontend if the public API URL changed.  
3. `pm2 restart anot-api`

---

## 15) Uploads directory

```bash
sudo mkdir -p /opt/anot/repo/anot-backend-main/anot-backend-main/src/uploads
sudo chown -R ubuntu:ubuntu /opt/anot/repo/anot-backend-main/anot-backend-main/src/uploads
```

---

## 16) Post-deploy checklist

- [ ] `https://api.yourdomain.com/` or health path returns JSON  
- [ ] `https://yourdomain.com` loads SPA; hard refresh on `/login` works  
- [ ] Sign-in succeeds; role routing works  
- [ ] **`CORS_ORIGINS`** matches real browser origins  
- [ ] TLS valid on all public hostnames  
- [ ] PM2 startup configured (`pm2 startup` + printed `sudo` line)

---

## 17) Operations commands

| Task | Command |
|------|---------|
| Disk | `df -h` |
| Nginx test | `sudo nginx -t` |
| Nginx reload | `sudo systemctl reload nginx` |
| Nginx logs | `sudo journalctl -u nginx -n 100 --no-pager` |
| API logs | `pm2 logs anot-api` |

---

## 18) Troubleshooting (AWS / VPS)

| Symptom | Check |
|---------|--------|
| **502 from Nginx** | `pm2 status`, `pm2 logs anot-api`; is Node listening on **5000**? |
| **DB connection failed** | RDS SG allows EC2 SG on **5432**; `DATABASE_URL` correct |
| **CORS / blocked** | `CORS_ORIGINS` exact match to UI **https** origin |
| **SPA 404 on refresh** | `try_files` / `index.html` fallback |
| **Mixed content** | UI and API both **https**; rebuild with correct **`VITE_API_URL`** |

---

## Related

- **Local development:** [LOCALHOST_SETUP.md](./LOCALHOST_SETUP.md)  
- **cPanel / static-only hosting:** [CPANEL_DEPLOYMENT.md](./CPANEL_DEPLOYMENT.md)
