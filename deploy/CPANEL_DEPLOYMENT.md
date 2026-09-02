# Anot — cPanel hosting deployment (complete guide)

**Anot’s backend** is **Node.js + PostgreSQL**. Typical **cPanel shared hosting** is built for **PHP + MySQL**, so you usually **cannot** run this API stack on the cheapest shared plans.

This guide uses the **recommended pattern**:

- **Frontend:** static files from **`npm run build`** → uploaded to cPanel **document root** (or subdomain).  
- **Backend:** **Node + Postgres** on a **VPS**, managed Node host, or cloud (EC2, Railway, etc.) — see **[AWS_DEPLOYMENT.md](./AWS_DEPLOYMENT.md)** for a full VPS example.

**Security:** Do not commit `.env` or real passwords. Replace all placeholders.

---

## Table of contents

1. [Hosting options](#1-hosting-options)  
2. [Prerequisites](#2-prerequisites)  
3. [Build the frontend for production](#3-build-the-frontend-for-production)  
4. [cPanel: subdomain and document root](#4-cpanel-subdomain-and-document-root)  
5. [Upload static files](#5-upload-static-files)  
6. [SPA routing (Apache `.htaccess`)](#6-spa-routing-apache-htaccess)  
7. [HTTPS (SSL)](#7-https-ssl)  
8. [Backend API configuration](#8-backend-api-configuration)  
9. [Example: SCP to a fixed docroot path](#9-example-scp-to-a-fixed-docroot-path)  
10. [File permissions (Linux docroot)](#10-file-permissions-linux-docroot)  
11. [Deploy checklist](#11-deploy-checklist)  
12. [Troubleshooting (cPanel / static)](#12-troubleshooting-cpanel--static)

---

## 1) Hosting options

| Option | Frontend (cPanel) | Backend + DB | When to use |
|--------|--------------------|--------------|-------------|
| **A — Recommended** | Static **`dist/`** in subdomain or `public_html` | **VPS / cloud** (Node + PM2 + Nginx + Postgres or RDS) | Most shared cPanel |
| **B** | Same | cPanel **Setup Node.js App** (if host offers it) + **remote** Postgres | Host explicitly supports Node + outbound DB |
| **C** | Same | Full stack on a **VPS with cPanel (AlmaLinux)** | You control Node + Postgres on the server |

This document focuses on **Option A**.

---

## 2) Prerequisites

| Item | Notes |
|------|--------|
| **cPanel** access | URL, username, password from provider |
| **Public API** | HTTPS URL ending with **`/api`** (e.g. `https://api.yourdomain.com/api`) |
| **Your PC** | Node + npm to run `npm run build` |

---

## 3) Build the frontend for production

The UI must be built with **`VITE_API_URL`** pointing at the **live** API (HTTPS in production).

**Windows (PowerShell):**

```powershell
cd anot-frontend-main\anot-frontend-main
Set-Content -Path .env.production -Value "VITE_API_URL=https://api.yourdomain.com/api"
npm ci
npm run build
```

**Linux / macOS:**

```bash
cd anot-frontend-main
printf '%s\n' 'VITE_API_URL=https://api.yourdomain.com/api' > .env.production
npm ci && npm run build
```

**Artifact:** folder **`dist/`**

You will upload the **contents** of `dist/` (so **`index.html`** is directly in the web root, not nested as `dist/index.html` unless your host requires that layout).

---

## 4) cPanel: subdomain and document root

1. Log in to cPanel (e.g. `https://YOUR_SERVER:2083`).  
2. **Domains** → **Create** subdomain (example: `app`).  
3. Note the **document root** path (examples):  
   - `/home/USERNAME/app.yourdomain.com`  
   - `/home/USERNAME/public_html` (main site)

That directory is where **`index.html`** and **`assets/`** must end up.

---

## 5) Upload static files

### Method A — File Manager

1. cPanel → **File Manager** → open the site’s document root.  
2. **Upload** a **zip** of the **contents** of `dist/` (select all files inside `dist`, zip them).  
3. **Extract** in place.  
4. Confirm **`index.html`** exists next to **`assets/`**.

### Method B — SFTP

```bash
sftp YOUR_CPANEL_USER@ftp.yourdomain.com
cd app.yourdomain.com
put -r dist/*
bye
```

Paths vary by host (`public_html`, subdomain folder, etc.).

### Method C — `scp` from your PC (OpenSSH)

```powershell
cd anot-frontend-main\anot-frontend-main
npm run build
scp -P 22 -r .\dist\* YOUR_USER@YOUR_HOST:/remote/path/to/document/root/
```

Use **`-P PORT`** if SSH is not on 22.

### Method D — `rsync` (if installed)

```bash
rsync -avz --delete ./dist/ YOUR_USER@YOUR_HOST:/remote/path/to/document/root/
```

**Warning:** `--delete` removes extra files in the target — only use if that folder contains **only** this app.

---

## 6) SPA routing (Apache `.htaccess`)

If refreshing **`/login`** or **`/admin`** returns **404**, create **`.htaccess`** in the **same folder as `index.html`**:

```apache
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>
```

Some budget hosts disable **`mod_rewrite`** — you may need a tier that allows it or nginx-based hosting.

**If your static site is behind Nginx (not Apache)** on the same machine, use instead inside `server { }`:

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

---

## 7) HTTPS (SSL)

1. cPanel → **SSL/TLS Status** or **Let’s Encrypt™ SSL** (if available).  
2. Issue or **Run AutoSSL** for your UI hostname (`app.yourdomain.com`, etc.).

After the UI is on **HTTPS**, the API URL in **`VITE_API_URL`** must be **`https://...`** (avoid mixed content). Rebuild if you changed it:

```powershell
cd anot-frontend-main\anot-frontend-main
Set-Content -Path .env.production -Value "VITE_API_URL=https://api.yourdomain.com/api"
npm run build
```

---

## 8) Backend API configuration

On the **machine that runs Node**, set at minimum:

```env
NODE_ENV=production
PORT=5000
TRUST_PROXY=1
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME
JWT_SECRET=PASTE_STRONG_RANDOM_SECRET
CORS_ORIGINS=https://app.yourdomain.com,https://yourdomain.com
```

**Rules:**

- **`CORS_ORIGINS`** must list every **browser origin** that loads the SPA (scheme + host, **no trailing slash**).  
- If the UI is at `https://app.yourdomain.com`, include that exact string.

Full VPS install (PM2, Nginx, Certbot): **[AWS_DEPLOYMENT.md](./AWS_DEPLOYMENT.md)** (same steps apply on non-AWS Linux VPS).

---

## 9) Example: SCP to a fixed docroot path

Some panels give a path like:

```text
/var/www/GUID/your-subdomain.yourdomain.com/
```

**Windows example:**

```powershell
cd anot-frontend-main\anot-frontend-main
npm run build
scp -r .\dist\* YOUR_USER@YOUR_SERVER:/var/www/GUID/your-subdomain.yourdomain.com/
```

Replace **`YOUR_USER`**, **`YOUR_SERVER`**, and the path with yours. Ensure **`CORS_ORIGINS`** on the API includes **`https://your-subdomain.yourdomain.com`** (or whatever the live UI origin is).

---

## 10) File permissions (Linux docroot)

If the web server user cannot read files:

```bash
sudo chown -R www-data:www-data /path/to/document/root
```

Use the user/group your host documents (`www-data` is common on Debian/Ubuntu).

---

## 11) Deploy checklist

- [ ] **`VITE_API_URL`** in `.env.production` is the **public https** API (`.../api`).  
- [ ] **`npm run build`** completed without errors.  
- [ ] **`index.html`** + **`assets/`** (+ `brand/` if present) uploaded to docroot.  
- [ ] **`.htaccess`** (Apache) or nginx **`try_files`** for SPA.  
- [ ] **SSL** active on UI hostname.  
- [ ] **`CORS_ORIGINS`** on API includes UI origin(s).  
- [ ] Smoke test: open site, sign in, **hard refresh** on an inner route (e.g. `/admin`).

---

## 12) Troubleshooting (cPanel / static)

| Symptom | What to check |
|---------|----------------|
| **Blank / 404 on refresh** | SPA fallback (`.htaccess` / nginx). |
| **“Failed to fetch” / network errors** | Wrong **`VITE_API_URL`**; API down; **HTTPS** UI calling **HTTP** API (mixed content); **CORS** list missing your UI origin. |
| **Upload size errors on API** | Limits are on **Node/Nginx** for the API host — increase **`client_max_body_size`** on the API proxy if needed (see AWS guide). |
| **Old UI after deploy** | Browser cache; confirm new hashed **`assets/*.js`** uploaded. |

---

## Related

- **Local development:** [LOCALHOST_SETUP.md](./LOCALHOST_SETUP.md)  
- **AWS / Linux VPS (API):** [AWS_DEPLOYMENT.md](./AWS_DEPLOYMENT.md)
