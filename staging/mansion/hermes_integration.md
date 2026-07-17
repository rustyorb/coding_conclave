# Hermes Mansion Integration & Smoke Check

This document provides documentation, launch paths, and verification evidence for wiring the Hermes Agent installation on **Cyberclaw** (`mars@192.168.0.69`) to use paths under the `/media/mars/Mansion` DEV mount.

> **Mount path (2026-07-17):** The 401 GB NTFS volume (`nvme0n1p3`, UUID `A0B8277DB82750D8`, label still `DEV`) is mounted at **`/media/mars/Mansion`** (same style as `/media/mars/AI` and `/media/mars/Ouroboros`). Previous path `/mnt/mansion` is empty; fstab was updated in place. Hermes `~/.hermes` symlinks target `/media/mars/Mansion/hermes/`.

---

## 1. Integration Strategy

To ensure safety and recoverability while executing the integration:
- **Virtualenv & Repository**: Left physically intact at `/home/mars/.hermes/hermes-agent` (on the ext4 Ubuntu OS partition). Running the Python virtualenv and Node modules directly from NTFS might encounter execution/shebang errors, case-sensitivity issues, or performance degradation.
- **Data & Configuration Files**: Moved from `/home/mars/.hermes` to `/media/mars/Mansion/hermes` (on the NTFS DEV partition). This includes SQLite databases (`state.db`, `kanban.db`), logs, skills, plugins, memories, and files like `.env`, `config.yaml`, and `auth.json`.
- **Symlink Wiring**: Created symbolic links under `/home/mars/.hermes/` pointing to `/media/mars/Mansion/hermes/` for all moved items. This routes all database writes, logs, and configuration reads transparently to the DEV partition while maintaining full compatibility with the existing binaries and systemd units.

---

## 2. Launch Paths from Mansion

Hermes can be executed using either of the following launch paths from `/media/mars/Mansion`:

### Path A: Transparent CLI Launch (Symlink-Backed)
This path is the default and runs the executable wrapper in the user's path. It respects the symlinks in `/home/mars/.hermes/` and resolves everything to the DEV partition.
```bash
/home/mars/.local/bin/hermes <command>
```
*Example usage:*
```bash
/home/mars/.local/bin/hermes status
/home/mars/.local/bin/hermes doctor
```

### Path B: Explicit Environment Override
This path bypasses the user home directory symlinks and targets `/media/mars/Mansion/hermes` directly via the `HERMES_HOME` environment variable.
```bash
HERMES_HOME=/media/mars/Mansion/hermes /home/mars/.hermes/hermes-agent/venv/bin/hermes <command>
```
*Example usage:*
```bash
HERMES_HOME=/media/mars/Mansion/hermes /home/mars/.hermes/hermes-agent/venv/bin/hermes version
```

---

## 3. Evidence of Changes

### Stopped Services
Before performing file migrations, the background systemd services were stopped:
```bash
systemctl --user stop hermes-dashboard.service hermes-gateway.service
```

### Moved & Symlinked Items (63 Items Total)
The migration script moved 63 folders and files to `/media/mars/Mansion/hermes` and created symlinks back to `/home/mars/.hermes/`.
```text
Total symlinked items: 63
  [SYMLINK] config.yaml.bak.claudefix -> /media/mars/Mansion/hermes/config.yaml.bak.claudefix
  [SYMLINK] config.yaml.bak.20260518_103525 -> /media/mars/Mansion/hermes/config.yaml.bak.20260518_103525
  [SYMLINK] state.db -> /media/mars/Mansion/hermes/state.db
  [SYMLINK] config.yaml.bak.20260702_233124 -> /media/mars/Mansion/hermes/config.yaml.bak.20260702_233124
  [SYMLINK] .skills_prompt_snapshot.json -> /media/mars/Mansion/hermes/.skills_prompt_snapshot.json
  ...
Total physical items: 2
  [PHYSICAL] gateway.lock
  [PHYSICAL] gateway.pid
```

### Restarted & Verified Services
Both services were restarted and verified to be running successfully:
```bash
systemctl --user status hermes-dashboard.service hermes-gateway.service
```
*Output snippet:*
```text
● hermes-dashboard.service - Hermes Agent Dashboard
     Active: active (running) since Fri 2026-07-17 11:57:09 EDT; 5s ago
     CGroup: /user.slice/.../hermes-dashboard.service
             └─43326 /home/mars/.hermes/hermes-agent/venv/bin/python3 ... dashboard --host 0.0.0.0 --port 9119 --insecure --no-open

● hermes-gateway.service - Hermes Agent Gateway - Messaging Platform Integration
     Active: active (running) since Fri 2026-07-17 11:57:09 EDT; 5s ago
     CGroup: /user.slice/.../hermes-gateway.service
             └─43327 /home/mars/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run
```

---

## 4. Smoke Check Outputs (over SSH)

Running `hermes version` and `hermes doctor` diagnostics confirmed that Hermes operates normally and all environment checks are green:

### A. `hermes version`
```text
Hermes Agent v0.18.2 (2026.7.7.2) · upstream 9e1b1d75
Install directory: /home/mars/.hermes/hermes-agent
Install method: git
Python: 3.11.14
OpenAI SDK: 2.24.0
Update available: 614 commits behind — run 'hermes update'
```

### B. `hermes status`
```text
Profile: default
State DB: /home/mars/.hermes/state.db (55.67 MB, 21 tables)
Total sessions: 13
Active sessions: 1
Web UI: enabled
Gateway: enabled
```

### C. `hermes doctor`
```text
All checks passed! 🎉
```

---

## 5. Recovery Procedure (Rollback)

If you ever need to restore the original Ubuntu OS drive layout and remove the `/media/mars/Mansion` dependency, you can run the rollback command in the migration helper script:
```bash
python3 /tmp/migrate_hermes.py rollback
```
This command:
1. Stops the running services.
2. Identifies all symlinks in `/home/mars/.hermes/` pointing to `/media/mars/Mansion/hermes/`.
3. Deletes those symlinks and moves the physical files and folders back to `/home/mars/.hermes/`.
4. Restarts the systemd user services.
