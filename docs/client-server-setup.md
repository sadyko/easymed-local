# Easy-Med Local — Installing at a Clinic (Client Server Setup)

How to set up Easy-Med on a client's premises: one "server PC" in the clinic
runs the app; every other computer uses it through a browser over the clinic's
LAN/Wi-Fi. No internet is needed at any point at the clinic.

Matches the agreed design in `docs/specs/2026-08-01-local-backend-design.md`.

> **Status note:** installable once Phase 1 (Foundation) is complete — the
> server entry point (`server/index.js`) and login flow must exist first.
> Screens become usable module by module as phases 2–4 convert them.

---

## 1. What you need

- **Server PC** at the clinic: any 64-bit Windows 10/11 PC, 4+ GB RAM, SSD
  preferred. Should be plugged into the router by **Ethernet cable** (not
  Wi-Fi) and stay powered on during working hours.
- **Workstations** (reception, doctors, cashier, lab): any computer with a
  modern browser. Nothing is installed on them.
- **USB stick** with the install package (below).

## 2. Prepare the install package (in the office, with internet)

The clinic has no internet, so everything is prepared beforehand:

1. Download the **Node.js Windows x64 installer** (same major version as the
   dev machine — currently Node 24) and put it on the USB stick.
2. Copy the whole `easymed.uz/` project folder onto the stick **including
   `node_modules/`** (it contains the prebuilt `better-sqlite3` binary for
   Windows x64 — since the clinic can't run `npm install`, it ships with the
   app). Exclude `data/` and `backups/` — those are created on site.
3. Optional but recommended: also put NSSM (`nssm.exe`) on the stick to run
   the app as a Windows service.

## 3. Install on the server PC

1. Run the Node.js installer (all defaults).
2. Copy the project folder from the stick to e.g. `C:\EasyMed`.
3. **First run — do this in a console window** (the one-time admin password is
   printed there):

   ```powershell
   cd C:\EasyMed
   npm start
   ```

   The server creates `data\easymed.db`, applies migrations automatically, and
   prints the generated admin password. Open `http://localhost:8000`, log in,
   and change the password. Write nothing down on paper that stays at the desk.

## 4. Fixed address on the clinic network

Workstations reach the server by IP, so the IP must never change:

- **Preferred:** in the clinic's router, add a **DHCP reservation** binding the
  server PC's MAC address to a fixed IP (e.g. `192.168.1.10`).
- **Alternative:** set a static IP directly in Windows network settings
  (Settings → Network → Ethernet → IP assignment → Manual).

Then allow the port through Windows Firewall (LAN only):

```powershell
netsh advfirewall firewall add rule name="EasyMed" dir=in action=allow protocol=TCP localport=8000 remoteip=localsubnet
```

Test from any other clinic PC: open `http://192.168.1.10:8000` — the login
page must appear.

## 5. Autostart (survives reboots and crashes)

**Option 1 — NSSM service (recommended):** runs without anyone logged in and
restarts automatically if the process crashes.

```powershell
nssm install EasyMed "C:\Program Files\nodejs\node.exe" "C:\EasyMed\server\index.js"
nssm set EasyMed AppDirectory C:\EasyMed
nssm set EasyMed AppStdout C:\EasyMed\logs\service.log
nssm set EasyMed AppStderr C:\EasyMed\logs\service-err.log
nssm start EasyMed
```

**Option 2 — Task Scheduler (no extra tools):** create a task triggered
"At startup", action `node server\index.js`, start-in `C:\EasyMed`, "Run
whether user is logged on or not".

Reboot the server PC once and confirm the app comes back on its own.

## 6. Workstations

On each clinic computer, open `http://192.168.1.10:8000` and put a shortcut on
the desktop (browser menu → More tools → Create shortcut). That's the entire
workstation setup. Each employee logs in with their own account, created by
the clinic admin in the user-management screen.

## 7. Backups

- The app writes a daily copy of the database into `backups\` automatically
  and keeps a bounded number.
- The whole clinic dataset is **one file**. Teach the clinic admin: copying
  the newest `backups\easymed-YYYY-MM-DD.db` to a USB stick or NAS once a
  week is a full off-machine backup. Restoring = stopping the service,
  putting the file back as `data\easymed.db`, starting the service.

## 8. Updates

1. Bring the new app version on a USB stick (again including `node_modules/`
   if dependencies changed).
2. Stop the service (`nssm stop EasyMed`).
3. Replace the app files — **never touch `data\` or `backups\`**.
4. Start the service. Migrations run automatically at startup; no manual
   database steps ever.

## 9. Quick troubleshooting

| Symptom | Check |
|---|---|
| Workstation can't open the page | Server PC on? Ping `192.168.1.10`. Firewall rule present? Same network/VLAN? |
| Page opens on server but not on workstations | Firewall rule missing or IP changed — re-check §4. |
| App gone after reboot | Service not installed/failed — `nssm status EasyMed`, read `logs\service-err.log`. |
| Forgot admin password | Admin resets it via user management; if no admin can log in, restore procedure is defined by support (do not hand-edit the DB at the clinic). |
