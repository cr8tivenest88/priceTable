# Pricing Engine — Quick Reminders

For pricing logic, config structure, and API docs see **GUIDE.md**.
This file is just the "how do I do X again?" cheat sheet.

---

## Common commands

| Command | What it does |
|---|---|
| `npm start` | Run the server locally on port 3000 |
| `npm run backup` | Pull latest `config.json` + `config-largeformat.json` from gmtech server (bash) |
| `npm run backup:ps` | Same as above, PowerShell version |
| `npm run deploy` | Push local **code only** to gmtech, restart, and healthcheck. Snapshots remote configs to `backups/*.remote.*.bak` first; rotates the previous remote `nohup.out` into `logs/`; aborts if `/api/health` doesn't respond within 15s (prints the tail of the new log). **Does not touch remote configs.** |
| `npm run deploy:push-config` | Escape hatch — explicitly `scp` local `config.json` + `config-largeformat.json` to gmtech. Use only when you intentionally want to overwrite live configs (e.g. restoring from a backup). |

After a backup, check what changed:
```bash
git diff config.json config-largeformat.json
```

> **Why deploy no longer pushes configs:** the server is the source of truth for prices. The old deploy script `scp`'d local `config.json` over the live one, which silently wiped any admin-UI edits made since the last `npm run backup`. The flyer prices entered May 1 2026 were lost this way. Now deploy only ships code, and configs flow remote → local via `npm run backup`.

---

## Server (gmtech)

| | |
|---|---|
| Folder | `/home/gmtech/priceTable-1/pricing-engine` |
| Process | Node.js, `server.js` |
| Port | 3000 (nginx reverse proxy on :80 → :3000) |
| Auth | Basic auth via `/etc/nginx/.htpasswd` |
| SSH host | `gmtech` |

Quick SSH actions:
```bash
ssh gmtech                                    # log in
ssh gmtech "pgrep -af node"                   # check server is running
ssh gmtech "tail -f ~/priceTable-1/pricing-engine/nohup.out"   # tail logs
```

---

## Config files

| File | Purpose |
|---|---|
| `config.json` | Standard products (business cards, flyers, stickers, etc.) |
| `config-largeformat.json` | Large format products (canvas, posters, banners — sqft pricing) |
| `backups/*.{ts}.bak` | Local config snapshots saved before each `npm run backup` (pre-overwrite copies of local) |
| `backups/*.remote.{ts}.bak` | Remote config snapshots saved before each `npm run deploy` (read-only — local file is never touched) |

The **server is the source of truth** — edits happen in the live admin UI, then `npm run backup` pulls them down to commit locally.

---

## Typical workflows

### "I edited prices in the live UI, now I want to commit them"
```bash
npm run backup
git diff config.json config-largeformat.json
git add config.json config-largeformat.json
git commit -m "..."
```

### "I changed code locally and want it live"
```bash
npm run deploy        # ships code only; remote configs are left alone
```

### "I need to push a config from local to live" (rare — e.g. restoring a lost backup)
```bash
npm run backup                # pull current remote first so you can diff
git diff config.json          # confirm your local really is what you want live
npm run deploy:push-config    # overwrite remote configs with local
```

### "I want to test locally before deploying"
```bash
npm run backup        # get live configs
npm start             # http://localhost:3000
```

---

## Pricing workflow note

Sometimes pricing starts from a **competitor price**, working backwards to derive cost, then markup + add-ons applied on top. Keep that in mind when tuning `scale_factor` / `setup_cost` — the target sell price is often the input, not the output.
