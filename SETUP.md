# Easy-Med Local — Setup

Fully local clinic system. No internet is needed to run it.

## Requirements
- Windows PC (the "server PC")
- Node.js 24+ (one-time install)

## First start
Open a terminal in this folder:

    npm ci --ignore-scripts   (first time only, needs internet once)
    npm start

`--ignore-scripts` is safe here: better-sqlite3 ships a prebuilt Windows
binary, so nothing needs to compile (a plain `npm install` tries to and
fails on machines without Visual Studio build tools).

The console prints the addresses and, on the very first run, the generated
admin password:

    Easy-Med Local is running.
      On this PC:      http://localhost:8000
      On the network:  http://192.168.x.x:8000

    FIRST RUN - admin account created:
      username: admin
      password: <generated>

Log in and change the password (Users page → Reset password on your own row).
If Windows Firewall asks, click "Allow access" so other clinic PCs can connect.

## Daily use
- Server PC: keep `npm start` running (autostart comes in a later phase).
- Any other PC on the clinic network: open `http://<server-ip>:8000` in a browser.
- All data lives in one file: `data/easymed.db`. To back up, stop the server
  and copy that file (automatic backups come in a later phase).
- If the app says the port is already in use, Easy-Med is already running —
  check for an open Easy-Med window before starting it again.

## Tests
    npm test
