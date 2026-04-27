# Plan: checkRenpy Web GUI

## What the CLI script does

Scans two directories of RenPy game folders:
- `/home/share/Software/Games/RenPY/Watching/`
- `/home/share/Software/Games/RenPY/hold`

Each game folder contains metadata files (`.url`, `.version`, `.last`) that the CLI reads/writes.  
**The web version replaces all per-folder files with a single `games.json` database.**

For each game it:
1. Follows HTTP redirects (saves new URL if changed)
2. Scrapes the game page for latest version + release date
3. Detects Abandoned / Complete status from the page title
4. Saves updated metadata back to `games.json`
5. Displays all games sorted by release date

---

## Target: Web GUI (Docker)

A single-page dashboard that replaces the terminal output with a sortable, filterable table and a live scan progress feed. Deployed as a Docker container with a volume-mounted `games.json` for persistence.

---

## Architecture

```
checkrenpy-web/
├── app.py              # FastAPI backend
├── scanner.py          # scraping logic — no I/O side-effects, returns dicts
├── store.py            # read/write games.json (single source of truth)
├── static/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── Dockerfile
├── docker-compose.yml
└── requirements.txt
```

**Backend**: FastAPI + uvicorn  
**Frontend**: Vanilla HTML/CSS/JS (no framework)  
**Live updates**: Server-Sent Events (SSE) from `/scan/stream`  
**Storage**: `games.json` mounted into the container at `/data/games.json`

---

## Data Storage — `games.json`

Single file, volume-mounted so data survives container restarts.

```json
[
  {
    "name": "GameTitle",
    "group": "Watching",
    "url": "https://...",
    "installed_version": "0.9.1",
    "scraped_version": "1.0.0",
    "release_date": "2024-11-15",
    "status": "Active | Abandoned | Complete",
    "needs_update": true,
    "update_count": 15,
    "last_checked": "2025-04-26T10:00:00",
    "error": null
  }
]
```

`store.py` owns all reads and writes — `app.py` and `scanner.py` never touch the file directly.

### `update_count` rules

- Incremented by 1 each time a scan detects that `scraped_version` has changed to a value different from what was previously stored (i.e. a new release appeared since the last scan).
- **Not** incremented if the version string is unchanged from the prior scan result.
- Reset to `0` when the user clicks **Played** (along with `needs_update → false`).
- Survives container restarts (stored in `games.json`).

---

## Backend API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/games` | Return all games from `games.json` (no scraping) |
| POST | `/games` | Add a new game entry (name, group, url) |
| DELETE | `/games/{name}` | Remove a game entry |
| POST | `/scan` | Bulk scan — check all games (default behavior) |
| POST | `/scan/{name}` | Check a single game by name |
| GET | `/scan/stream` | SSE stream — emits progress + result events during a scan |
| POST | `/games/{name}/played` | Mark game as played — sets `needs_update=false`, `update_count=0` |

---

## Frontend Features

- **Table view**: name, group, installed version, latest version, release date, status badge, link icon, update count, actions
- **Sorted by release date** (newest first) by default; click any column header to re-sort
- **Filter buttons**: All | Needs Update | Abandoned | Complete | Errors
- **Scan All button** (default / prominent): POST /scan, subscribe to SSE, update rows live
- **Per-row Check button**: POST /scan/{name}, updates just that row
- **Per-row Played button**: shown only when `needs_update=true`; POST /games/{name}/played → clears badge and count on that row immediately
- **Update count badge**: shown on rows where `update_count > 0`; displays as e.g. `15x` next to the game name — mirrors the CLI's NeedToUpdate display (e.g. `15  Grandma's House  https://...`)
- **Add Game form**: inline form (name, group dropdown, URL) → POST /games → row appears immediately
- **Status badges**: green (up-to-date), yellow (needs update, with count), red (error), grey (abandoned), blue (complete)
- **Delete button** per row (with confirmation) → DELETE /games/{name}

---

## Implementation Steps

### Step 1 — `store.py` (JSON persistence)
- `load_games()` → list of dicts from `games.json` (returns `[]` if file missing)
- `save_games(games)` → write atomically (write to `.tmp`, then rename)
- `add_game(name, group, url)` → load, append, save; raise if name already exists
- `remove_game(name)` → load, filter out, save
- `update_game(name, fields)` → load, find by name, merge fields, save
- `mark_played(name)` → update_game with `{needs_update: false, update_count: 0}`

Verify: unit-test each function in a Python REPL with a temp file.

### Step 2 — `scanner.py` (scraping logic, no I/O)
Pure functions, no file access:
- `check_url(url)` → follow redirects, return final URL
- `scrape_game(url)` → return `{scraped_version, release_date, status}`
- scrape_game(url) should use crawl4ai to convert the page to md then look for the scraped_version, release_date, and status
- `scan_one(game_dict)` → call check_url + scrape_game, return updated game dict with `last_checked` and `error`; if `scraped_version` changed from the value in the input dict, increment `update_count` by 1 and set `needs_update=true`

Verify: call `scan_one({"url": "..."})` in REPL, confirm it returns expected fields.

### Step 3 — `app.py` (FastAPI)
- Wire up all API endpoints to `store.py` and `scanner.py`
- `POST /scan` runs `scan_one` for each game in a background thread, publishes SSE events per game
- `POST /scan/{name}` runs `scan_one` for one game, saves result, returns updated game object
- `GET /scan/stream` yields SSE events from an asyncio Queue

Verify: `uv run uvicorn app:app --reload`, hit `/games` → returns JSON, POST /games adds entry.

### Step 4 — Frontend (`index.html` + `app.js`)
- On load: fetch `/games`, render table sorted by `release_date`
- keep watching and hold in seperate tables in the output.
- Scan All button: POST /scan → open EventSource → update rows in-place as SSE events arrive
- Per-row Check button: POST /scan/{name} → update that row
- Per-row Played button (visible when needs_update=true): POST /games/{name}/played → zero the count badge, hide the button
- Update count badge renders as `15x` inline with the game name when update_count > 0
- Add Game form: small panel with name / group / URL fields → POST /games → prepend row
- Sort and filter purely in JS (no re-fetch)

Verify: open in browser, table loads, scan updates live, add form works.

### Step 5 — Docker
`Dockerfile`:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8765"]
```

`docker-compose.yml`:
```yaml
services:
  checkrenpy:
    build: .
    ports:
      - "8765:8765"
    volumes:
      - ./data:/data
    restart: unless-stopped
```

`games.json` lives at `./data/games.json` on the host, mounted to `/data/games.json` in the container.

Verify: `docker compose up --build`, open `http://localhost:8765`, full flow works.

---

## Dependencies

```
fastapi
uvicorn
requests
crawl4ai
```

`requirements.txt` (no uv inside Docker — plain pip):
```
fastapi
uvicorn[standard]
requests
crawl4ai
```

---

## Running (dev, outside Docker)

```bash
cd checkrenpy-web
uv run uvicorn app:app --host 0.0.0.0 --port 8765 --reload
```

## Running (production)

```bash
docker compose up -d
```

---

## Out of Scope

- No authentication
- No dark mode toggle (use system `prefers-color-scheme`)
- No import tool for existing `.url`/`.version`/`.last` files (add games manually via the form)
