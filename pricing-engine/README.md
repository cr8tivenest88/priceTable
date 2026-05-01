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
| `npm run deploy` | Push local code + configs to gmtech and restart the server |

After a backup, check what changed:
```bash
git diff config.json config-largeformat.json
```

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
| `backups/*.bak` | Auto-saved before every `npm run backup` |

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
npm run backup        # first, grab any live config edits so deploy doesn't overwrite them
git status            # confirm configs are clean / committed
npm run deploy
```

### "I want to test locally before deploying"
```bash
npm run backup        # get live configs
npm start             # http://localhost:3000
```

---

## Pricing workflow note

Sometimes pricing starts from a **competitor price**, working backwards to derive cost, then markup + add-ons applied on top. Keep that in mind when tuning `scale_factor` / `setup_cost` — the target sell price is often the input, not the output.
