# PM2 Setup — Anot Health Backend

[PM2](https://pm2.keymetrics.io/) is a production process manager for Node.js. It
keeps the backend running, restarts it on crashes, manages logs, and can relaunch
the app automatically after a server reboot.

The PM2 configuration lives in
[`anot-backend-main/anot-backend-main/ecosystem.config.js`](../anot-backend-main/anot-backend-main/ecosystem.config.js).

---

## 1. Install PM2 (globally)

```bash
npm install -g pm2
```

Verify the install:

```bash
pm2 --version
```

---

## 2. Start the backend

Run all commands from the backend folder:

```bash
cd anot-backend-main/anot-backend-main
```

Make sure dependencies are installed and your environment variables are set
(via a `.env` file or the host's environment): `JWT_SECRET`, `DATABASE_URL`,
`SENTRY_DSN`, and any API keys.

```bash
npm install
```

Start using the default environment:

```bash
pm2 start ecosystem.config.js
```

Start using the **production** environment block:

```bash
pm2 start ecosystem.config.js --env production
```

Check status at any time:

```bash
pm2 status
pm2 list
```

---

## 3. Monitor

Live dashboard (CPU, memory, restarts, logs):

```bash
pm2 monit
```

Detailed info for the app:

```bash
pm2 show anot-backend
```

---

## 4. View logs

PM2 streams stdout/stderr and also writes to log files configured in
`ecosystem.config.js` (`logs/anot-backend-out.log` and
`logs/anot-backend-error.log`).

```bash
pm2 logs                 # all apps, live tail
pm2 logs anot-backend    # just the backend
pm2 logs --lines 200     # last 200 lines
pm2 flush                # clear all log files
```

---

## 5. Common lifecycle commands

```bash
pm2 restart anot-backend   # restart (e.g. after a deploy)
pm2 reload anot-backend    # zero-downtime reload
pm2 stop anot-backend      # stop the process
pm2 delete anot-backend    # remove it from PM2's process list
```

After pulling new code:

```bash
git pull
npm install
pm2 restart anot-backend
```

---

## 6. Auto-start on server reboot

This generates and installs a startup script for your OS/init system so PM2
(and your saved processes) relaunch automatically when the server boots.

```bash
pm2 startup
```

PM2 prints a command (usually prefixed with `sudo`) — copy and run that exact
command to register the startup hook.

> **Windows:** the built-in `pm2 startup` is not supported. Use
> [`pm2-windows-startup`](https://www.npmjs.com/package/pm2-windows-startup)
> instead:
>
> ```bash
> npm install -g pm2-windows-startup
> pm2-startup install
> ```

---

## 7. Save the process list

After starting your apps (and any time you change which apps are running), save
the current process list so PM2 can restore it on reboot:

```bash
pm2 save
```

To clear a previously saved list:

```bash
pm2 unstartup   # remove the startup hook
pm2 save --force
```

---

## Typical first-time deployment (all together)

```bash
cd anot-backend-main/anot-backend-main
npm install
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup        # then run the command it prints
pm2 monit          # confirm it's healthy
```
