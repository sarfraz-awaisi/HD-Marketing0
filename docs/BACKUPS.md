# Daily backups on this Mac

Added 17 October 2026. Every evening this Mac saves two **encrypted** backups of the live CRM:

| Backup         | Contains                                                               | File name                     |
| -------------- | ---------------------------------------------------------------------- | ----------------------------- |
| Database       | All CRM records: accounts, leads, calls, deals, audit history and more | `hd-crm-<time>.dump.age`      |
| Uploaded files | Property photos, documentation and KYC files, call recordings          | `hd-crm-files-<time>.tar.age` |

Backups are kept for **30 days** in `~/HD-CRM-Backups` and run daily at **21:30**. If the Mac is asleep or off at that time, the backup runs when it next wakes. Each database backup is recorded in the admin **System status** card. Both files are encrypted with your own key, so a copied backup file is unreadable without it.

## One-time setup

1. Install the tools (done once):

   ```sh
   brew install libpq age
   ```

2. Run the installer from the project folder:

   ```sh
   cd "/Users/air/Desktop/HD marketing/hd-marketing-crm"
   node scripts/install-mac-backup.mjs
   ```

   It creates the private folder `~/.hd-crm`, an encryption key, the settings file and the daily schedule. Running it again is safe and keeps your settings. If you change `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` in the project `.env`, run it again.

3. Add the database address. In Supabase, click **Connect** at the top of the project, choose **Session pooler**, and copy the connection string. Then open the settings file:

   ```sh
   open -e ~/.hd-crm/backup.env
   ```

   Paste it after `SUPABASE_DB_URL=`, replace `[YOUR-PASSWORD]` **including the square brackets** with your database password (letters and numbers only), add `?sslmode=require` to the end, and save. A rejected password shows as "Backup failed"; check for leftover brackets first. Forgot the database password? Reset it under **Project Settings → Database**. Your CRM keeps working; only tools using the old password are affected.

   For stronger certificate checking, download the certificate from **Project Settings → Database → SSL Configuration** and save it as `~/.hd-crm/supabase-ca.crt`. Run the installer again, then end the address with `?sslmode=verify-full` instead.

4. **Protect the key.** Copy `~/.hd-crm/backup-key.txt` into your password manager or onto a USB drive. **Without this key, the backups cannot be opened.** Anyone with the key and a backup file can read your customer data, so never share it or put it in the project folder.

5. Run a backup now to confirm it works:

   ```sh
   bash ~/.hd-crm/bin/run-backup.sh
   ```

   Expected: `Encrypted database backup recorded` and `Encrypted file backup saved (N files)`. The two files appear in `~/HD-CRM-Backups`.

## Checking it later

- Files: `open ~/HD-CRM-Backups`
- Log of every run: `tail -n 20 ~/.hd-crm/backup.log`
- Admin dashboard: **System status** shows the latest database backup.
- Run one immediately: `launchctl kickstart gui/$(id -u)/com.hdmarketing.crm-backup`
- Change the time: `BACKUP_TIME=13:00 node scripts/install-mac-backup.mjs`

Keep a copy off this Mac too. A copy that lives only on the same Mac is lost with it. Because the files are encrypted, copying `~/HD-CRM-Backups` to iCloud Drive, Google Drive or a USB drive is safe. Keep the key separate from the backup copies.

## Restore

Practise a restore into a **separate test Supabase project**, never the live one; see [deploy/restore.md](../deploy/restore.md). To open the archives on a trusted machine that has the key:

```sh
age --decrypt --identity /path/to/backup-key.txt --output restore.dump hd-crm-<time>.dump.age
age --decrypt --identity /path/to/backup-key.txt --output files.tar hd-crm-files-<time>.tar.age
tar -xf files.tar   # folders named after each storage bucket
```

## Turn off

```sh
launchctl bootout gui/$(id -u)/com.hdmarketing.crm-backup
rm ~/Library/LaunchAgents/com.hdmarketing.crm-backup.plist
```

Your existing backups and key stay where they are.
