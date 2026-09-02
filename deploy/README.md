# Anot — deployment documentation

This folder contains **three complete guides**. Commands assume repository paths from the **Git clone root** (`anot/`) unless noted.

| Guide | File | Use when |
|-------|------|----------|
| **Localhost setup** | [LOCALHOST_SETUP.md](./LOCALHOST_SETUP.md) | Running API + Vite on your machine |
| **Amazon AWS** | [AWS_DEPLOYMENT.md](./AWS_DEPLOYMENT.md) | EC2 + Nginx + PM2 + RDS (or Postgres on VPS) |
| **cPanel hosting** | [CPANEL_DEPLOYMENT.md](./CPANEL_DEPLOYMENT.md) | Static frontend on cPanel; API elsewhere |

**Security:** Never commit `.env`, `.env.local`, `.env.production` with secrets, `JWT_SECRET`, database passwords, or SSH private keys. Replace placeholders like `CHANGE_ME_*` / `YOUR_*`. Never run dev seed scripts against production.

**What you ship**

| Package | Path |
|---------|------|
| Backend | `anot-backend-main/` |
| Frontend | `anot-frontend-main/` |

**Product overview** (features, upstream repos): **[`../README.md`](../README.md)**

---

## Ultra-short quick start (local)

```powershell
cd "C:\Path\To\anot"
npm install
npm run install:all
```

Create **`anot-backend-main\anot-backend-main\.env`** with **`JWT_SECRET`** and **`DATABASE_URL`** (see [LOCALHOST_SETUP.md](./LOCALHOST_SETUP.md)), then:

```powershell
npm run dev
```

- API: `http://127.0.0.1:5000/`  
- UI: URL printed by Vite (often `http://localhost:5173/`)
