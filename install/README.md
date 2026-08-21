# Installing Easy-Med at a clinic

This page is for whoever sets Easy-Med up on the clinic's computer. It does not
assume you write code — just that you can copy a folder and run one command.

## What you need before you start

- The Easy-Med files, as a folder (given to you by whoever provides your
  updates — for example on a USB stick).
- Windows (this only runs on Windows).
- [Node.js](https://nodejs.org) already installed on this PC. If you're not
  sure, ask whoever set up the PC, or open a Windows PowerShell window and
  type `node --version` — if it prints something like `v24.14.0`, it's
  installed.
- Administrator access on this PC (the account you're logged in with needs to
  be able to say "yes" to a Windows permission prompt).

## What to copy, and where

Copy the whole Easy-Med folder you were given anywhere convenient on the PC —
your Desktop, or a USB stick you plug in, both work. You do **not** need to
put it in any particular place; the installer takes care of that.

## How to install

1. Right-click the **Start** menu, choose **Windows PowerShell (Admin)** (or
   search for "PowerShell", right-click it, and choose **Run as
   administrator**). Say yes to the permission prompt Windows shows you.
2. In the window that opens, type `cd` followed by a space, then drag the
   `install` folder (inside the Easy-Med folder you copied) into the window,
   and press Enter. This puts you inside the `install` folder.
3. Type:

   ```
   .\install-service.ps1 -Source "..\"
   ```

   (the `..\` means "the Easy-Med folder one level up from `install`" — if you
   copied things differently, point `-Source` at wherever the Easy-Med folder
   ended up, in quotes if the path has spaces in it).

That's it. You only need to install once per computer. Installing again later
(for example, to apply an update someone hands you) is safe to re-run the same
way — it never touches your existing patient records.

## What it asks for

Nothing, if you're doing a normal install — no prompts, no typing anything in.
The one exception: if you are **not** running as administrator, it stops
immediately and tells you plainly to right-click PowerShell and choose "Run as
administrator". If you see that message, close the window and start again
from step 1 above.

## What it prints, and how to check it worked

When it finishes successfully, you'll see something like:

```
Easy-Med is running.
  Open:  http://localhost:8000
```

Open that address in a web browser (Chrome, Edge, whatever's on the PC) — you
should see the Easy-Med login screen.

If this is the very first time Easy-Med has run on this PC, it also prints a
one-time admin login:

```
FIRST RUN - an admin account was created (read from the service log):
  username: admin
  password: <a generated password>
Log in and change this password.
```

Write that password down (or copy it) before closing the window — log in with
it once, then change the password from inside Easy-Med. It is not shown again
after this.

From now on, Easy-Med starts automatically whenever this PC starts — you do
not need to open anything or run any command. If you ever want to check it's
running without opening a browser, an administrator PowerShell window can run:

```
Get-Service EasyMed
```

and it should say `Running`.

## Where your data lives — and how to back it up

**Everything that matters — every patient, every visit, the clinic's licence,
anything uploaded — lives in one folder:**

```
C:\EasyMed\data
```

**That folder is your entire backup.** If you copy `C:\EasyMed\data` (to a USB
drive, to cloud storage, wherever your clinic keeps backups) you have
everything. Nothing else under `C:\EasyMed` needs to be backed up — the rest
is just a copy of the software, which can always be reinstalled from a fresh
copy of Easy-Med.

Installing an update also automatically saves a safety copy of the database
just before it applies, so a bad update can be undone. Those safety copies
appear in:

```
C:\EasyMed\data\backups\
```

The three most recent are kept automatically; older ones are cleaned up on
their own. You don't need to do anything with this folder, but if you're ever
asked "is there a backup from before the update?" — this is where to look.

## Restarting or stopping Easy-Med

**Stopping this service is not a graceful shutdown — it is closer to pulling
the plug.** The Easy-Med program does not get a chance to finish anything in
progress; it is simply stopped. This is fine and expected: Easy-Med's database
is built to survive being stopped this way without losing or corrupting data
(this is the same reason Easy-Med recovers cleanly if the PC loses power). But
if anyone ever wonders why there's no "shutting down..." message when the
service stops — this is why, and it's by design, not a bug.

To restart Easy-Med by hand (for example, after an update, or if it's
misbehaving), an administrator PowerShell window can run:

```
Restart-Service EasyMed
```

## Uninstalling

If you ever need to remove Easy-Med from a PC — for example, replacing this
computer — run, from an administrator PowerShell window inside the `install`
folder:

```
.\uninstall-service.ps1
```

This removes the Windows service, so Easy-Med stops starting automatically.

**It does NOT delete your data.** `C:\EasyMed\data` — every patient record,
the licence, everything — is left exactly where it was. The script says this
on screen when it finishes, and tells you the exact folder. If you are
decommissioning the PC entirely, that folder is the one thing to copy off
first; everything else can simply be deleted.

## If something doesn't look right

- **"This installer needs to be run as an Administrator"** — you didn't right
  click PowerShell and choose "Run as administrator". Close the window and
  start again from step 1.
- **Easy-Med doesn't answer at `http://localhost:8000` after installing** —
  open `C:\EasyMed\logs\service.log` in Notepad; the most recent lines at the
  bottom usually say what went wrong (for example, Node.js not being
  installed, or another program already using the same port).
- **You're not sure if it's running** — an administrator PowerShell window can
  run `Get-Service EasyMed`. `Running` means it's up; `Stopped` means it
  isn't (try `Start-Service EasyMed`).
