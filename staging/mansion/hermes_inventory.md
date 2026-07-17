# Hermes Agent Inventory (Cyberclaw OS Drive)

This document catalogs the Hermes Agent installation, configurations, environment, data stores, and systemd units located on the Ubuntu OS drive of the **Cyberclaw** host (`mars@192.168.0.69`).

---

## 1. Overview
* **Host**: `mars@192.168.0.69` (Cyberclaw / MSI Vector 16)
* **OS**: Ubuntu 24.04.4 LTS (Kernel: 7.0.0-28-generic)
* **Hermes Version**: `Hermes Agent v0.18.2 (2026.7.7.2) · upstream 226e8de8`
* **Python Version**: `3.11.14`
* **OpenAI SDK Version**: `2.24.0`

---

## 2. Directory Layout & Absolute Paths

| Category | Path on Host | Description |
| :--- | :--- | :--- |
| **Hermes Home / Data Dir** | `/home/mars/.hermes` | Core state, configurations, plugins, skills, and logs |
| **Virtual Environment** | `/home/mars/.hermes/hermes-agent/venv` | Python virtualenv containing packages and bin/hermes |
| **Agent Repository** | `/home/mars/.hermes/hermes-agent` | Git repository for the Hermes Agent core code |
| **Binary Wrapper** | `/home/mars/.local/bin/hermes` | Executable shell wrapper in user PATH |
| **Configuration File** | `/home/mars/.hermes/config.yaml` | Main configuration settings (775 lines) |
| **Environment File** | `/home/mars/.hermes/.env` | API keys, tokens, and path declarations |
| **Active SQLite Database** | `/home/mars/.hermes/state.db` | Primary message history and session data store (55.6 MB) |
| **Kanban Database** | `/home/mars/.hermes/kanban.db` | Project management board data store (114 KB) |
| **Authentication File** | `/home/mars/.hermes/auth.json` | Active authentication keys and credentials cache |
| **Systemd User Units** | `/home/mars/.config/systemd/user/` | systemd user service configuration files |

---

## 3. Services & Intended Start Commands

Hermes on Cyberclaw runs two active user-space background services managed via `systemd --user`.

### A. hermes-dashboard.service
* **Unit File**: `/home/mars/.config/systemd/user/hermes-dashboard.service`
* **Status**: `active (running)`
* **Intended Start Command**: 
  ```bash
  /home/mars/.local/bin/hermes dashboard --host 0.0.0.0 --port 9119 --insecure --no-open
  ```
* **Alternate systemctl command**:
  ```bash
  systemctl --user start hermes-dashboard.service
  ```

### B. hermes-gateway.service
* **Unit File**: `/home/mars/.config/systemd/user/hermes-gateway.service`
* **Status**: `active (running)`
* **Intended Start Command**: 
  ```bash
  /home/mars/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run
  ```
* **Required Environment & Context**:
  * **Working Directory**: `/home/mars/.hermes`
  * **Environment Variables**:
    * `PATH=/home/mars/.hermes/hermes-agent/venv/bin:/home/mars/.hermes/hermes-agent/node_modules/.bin:/home/mars/.brv-cli/bin:/home/mars/.local/bin:/home/mars/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
    * `VIRTUAL_ENV=/home/mars/.hermes/hermes-agent/venv`
    * `HERMES_HOME=/home/mars/.hermes`
* **Alternate systemctl command**:
  ```bash
  systemctl --user start hermes-gateway.service
  ```

---

## 4. Evidence Outputs

The following raw outputs were collected from the Cyberclaw host via SSH on **2026-07-17**.

### A. Location Checks (`command -v` & `ls`)
```text
$ export PATH=/home/mars/.local/bin:$PATH && command -v hermes
/home/mars/.local/bin/hermes

$ ls -la /home/mars/.local/bin/hermes
-rwxrwxr-x 1 mars mars 114 May 18 10:35 /home/mars/.local/bin/hermes

$ cat /home/mars/.local/bin/hermes
#!/usr/bin/env bash
unset PYTHONPATH
unset PYTHONHOME
exec "/home/mars/.hermes/hermes-agent/venv/bin/hermes" "$@"

$ ls -la /home/mars/.hermes/hermes-agent/venv/bin/hermes
-rwxrwxr-x 1 mars mars 329 Jul 14 04:09 /home/mars/.hermes/hermes-agent/venv/bin/hermes
```

### B. Agent Repository Git Status (`git -C`)
```text
$ git -C /home/mars/.hermes/hermes-agent status -sb
## main...origin/main [behind 614]
?? agent/session_reflection.py
?? hermes_cli/dashboard_auth/middleware.py.bak-preauto-sso-fix
?? hermes_cli/dashboard_auth/middleware.py.bak.claudefix
?? tests/agent/test_iteration_budget_persistence.py
?? tests/agent/test_iteration_budget_snapshot.py
?? tests/agent/test_session_reflection.py
?? tools/goal_store.py

$ git -C /home/mars/.hermes/hermes-agent remote -v
origin	https://github.com/NousResearch/hermes-agent.git (fetch)
origin	https://github.com/NousResearch/hermes-agent.git (push)

$ git -C /home/mars/.hermes/hermes-agent log -n 1 --oneline
226e8de82 fix(gemini): restrict TTS client context to official host
```

### C. Systemd Unit Contents (`systemctl --user cat`)
```text
$ systemctl --user cat hermes-dashboard.service
# /home/mars/.config/systemd/user/hermes-dashboard.service
[Unit]
Description=Hermes Agent Dashboard
After=network.target

[Service]
Type=simple
ExecStart=/home/mars/.local/bin/hermes dashboard --host 0.0.0.0 --port 9119 --insecure --no-open
Restart=always
RestartSec=5

[Install]
WantedBy=default.target


$ systemctl --user cat hermes-gateway.service
# /home/mars/.config/systemd/user/hermes-gateway.service
[Unit]
Description=Hermes Agent Gateway - Messaging Platform Integration
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=/home/mars/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run
WorkingDirectory=/home/mars/.hermes
Environment="PATH=/home/mars/.hermes/hermes-agent/venv/bin:/home/mars/.hermes/hermes-agent/node_modules/.bin:/home/mars/.brv-cli/bin:/home/mars/.local/bin:/home/mars/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment="VIRTUAL_ENV=/home/mars/.hermes/hermes-agent/venv"
Environment="HERMES_HOME=/home/mars/.hermes"
Restart=always
RestartSec=5
RestartForceExitStatus=75
KillMode=mixed
KillSignal=SIGTERM
ExecReload=/bin/kill -USR1 $MAINPID
ExecStopPost=-/home/mars/.hermes/hermes-agent/venv/bin/python -m gateway.cgroup_cleanup
TimeoutStopSec=210
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

### D. Systemd Unit Status (`systemctl --user status`)
```text
$ systemctl --user status hermes-dashboard.service hermes-gateway.service
● hermes-dashboard.service - Hermes Agent Dashboard
     Loaded: loaded (/home/mars/.config/systemd/user/hermes-dashboard.service; enabled; preset: enabled)
     Active: active (running) since Fri 2026-07-17 11:16:37 EDT; 36min ago
   Main PID: 17249 (hermes)
      Tasks: 5 (limit: 70385)
     Memory: 74.2M (peak: 75.0M)
        CPU: 3.933s
     CGroup: /user.slice/user-1000.slice/user@1000.service/app.slice/hermes-dashboard.service
             └─17249 /home/mars/.hermes/hermes-agent/venv/bin/python3 /home/mars/.hermes/hermes-agent/venv/bin/hermes dashboard --host 0.0.0.0 --port 9119 --insecure --no-open

Jul 17 11:16:37 cyberclaw systemd[2431]: Started hermes-dashboard.service - Hermes Agent Dashboard.
Jul 17 11:16:38 cyberclaw hermes[17249]: HERMES_DASHBOARD_READY port=9119

● hermes-gateway.service - Hermes Agent Gateway - Messaging Platform Integration
     Loaded: loaded (/home/mars/.config/systemd/user/hermes-gateway.service; enabled; preset: enabled)
     Active: active (running) since Fri 2026-07-17 11:16:42 EDT; 36min ago
   Main PID: 17262 (hermes)
      Tasks: 9 (limit: 70385)
     Memory: 158.9M (peak: 169.6M)
        CPU: 5.061s
     CGroup: /user.slice/user-1000.slice/user@1000.service/app.slice/hermes-gateway.service
             └─17262 /home/mars/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run

Jul 17 11:16:42 cyberclaw systemd[2431]: Started hermes-gateway.service - Hermes Agent Gateway - Messaging Platform Integration.
```

### E. File System Listing (`ls -la /home/mars/.hermes`)
```text
$ ls -la /home/mars/.hermes | grep -E "\.db|\.yaml|\.json|\.env|logs|memories|skills|plugins|hermes-agent|cron|shared|sessions|audio_cache|image_cache|images"
drwx------   2 mars mars     4096 May 18 10:35 audio_cache
-rw-------   1 mars mars    17913 Jul 17 11:17 auth.json
-rw-------   1 mars mars      210 Jul 17 11:50 channel_directory.json
-rw-------   1 mars mars    20988 Jul 17 11:16 config.yaml
drwx------   3 mars mars     4096 Jul 17 11:53 cron
-rw-------   1 mars mars    23715 Jul  2 23:31 .env
-rw-------   1 mars mars      406 Jul 17 11:16 gateway_state.json
drwxrwxr-x  38 mars mars     4096 Jul 14 04:09 hermes-agent
drwx------   2 mars mars     4096 May 18 10:35 image_cache
drwxrwxr-x   2 mars mars     4096 Jul  7 00:42 images
-rw-r--r--   1 mars mars   114688 Jun 26 14:31 kanban.db
drwx------   3 mars mars     4096 Jun 22 15:48 logs
drwx------   2 mars mars     4096 Jul  2 15:29 memories
-rw-------   1 mars mars  3196037 Jul 17 11:16 models_dev_cache.json
-rw-------   1 mars mars      735 Jul  7 00:41 ollama_cloud_models_cache.json
drwxrwxr-x  38 mars mars     4096 Jun 13 14:05 plugins
-rw-rw-r--   1 mars mars      272 Jun  1 07:03 profile.yaml
-rw-------   1 mars mars     2429 Jul  7 00:42 provider_models_cache.json
drwx------   5 mars mars     4096 Jul 13 18:41 sessions
drwx------   2 mars mars     4096 Jul 17 11:17 shared
drwx------  30 mars mars     4096 Jul 17 11:17 skills
-rw-------   1 mars mars    26092 Jul  2 23:36 .skills_prompt_snapshot.json
-rw-r--r--   1 mars mars 55672832 Jul 17 11:20 state.db
```

### F. Environment File Key Inventory (`grep -o '^[A-Z...]*=' .env`)
```text
AGENT_BROWSER_EXECUTABLE_PATH=
BROWSERBASE_ADVANCED_STEALTH=
BROWSERBASE_PROXIES=
BROWSER_INACTIVITY_TIMEOUT=
BROWSER_SESSION_TIMEOUT=
GATEWAY_ALLOW_ALL_USERS=
GITHUB_TOKEN=
GLM_API_KEY=
IMAGE_TOOLS_DEBUG=
KIMI_API_KEY=
KIMI_CODING_API_KEY=
MOA_TOOLS_DEBUG=
OPENROUTER_API_KEY=
SEARXNG_URL=
SUDO_PASSWORD=
SUPERMEMORY_API_KEY=
TELEGRAM_ALLOWED_USERS=
TELEGRAM_BOT_TOKEN=
TELEGRAM_HOME_CHANNEL=
TERMINAL_ENV=
TERMINAL_LIFETIME_SECONDS=
TERMINAL_MODAL_IMAGE=
TERMINAL_TIMEOUT=
VISION_TOOLS_DEBUG=
WEB_TOOLS_DEBUG=
```

### G. Database Schema Details (Python reflection of `state.db`)
```text
$ python3 -c "import sqlite3; conn = sqlite3.connect('/home/mars/.hermes/state.db'); print([r[0] for r in conn.execute('SELECT name FROM sqlite_master WHERE type=\'table\'').fetchall()])"
['schema_version', 'sessions', 'messages', 'sqlite_sequence', 'state_meta', 'messages_fts', 'messages_fts_data', 'messages_fts_idx', 'messages_fts_content', 'messages_fts_docsize', 'messages_fts_config', 'messages_fts_trigram', 'messages_fts_trigram_data', 'messages_fts_trigram_idx', 'messages_fts_trigram_content', 'messages_fts_trigram_docsize', 'messages_fts_trigram_config', 'compression_locks', 'gateway_routing', 'async_delegations', 'session_model_usage']
```
