# checkRenpy

Web dashboard for tracking RenPy game updates from F95zone. Replaces a CLI script with a sortable, filterable table and live scan progress.

## Features

- Scans F95zone game threads for latest version, release date, and status (Active / Abandoned / Complete)
- Live scan progress via Server-Sent Events — rows update as each game finishes
- Groups games into separate tables (Watching, hold, etc.)
- Active items always sort above inactive items regardless of column
- Filter buttons: All | Needs Update | Abandoned | Complete | Errors
- Per-row Check button (scan one game), Mark as Updated button, Delete button
- Active checkbox per row — inactive games are skipped during bulk scans
- Scan-done checkbox (read-only) shows which games were checked this session
- Add Game form — name, group, URL
- Dark mode via system `prefers-color-scheme`

## Project layout

```
checkRenpy/
├── backend/
│   ├── app.py          # FastAPI — all API endpoints and SSE scan stream
│   ├── scanner.py      # Scraping logic (requests + BeautifulSoup); no file I/O
│   ├── store.py        # All reads/writes to games.json
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── data/
│   └── games.json      # Bind-mounted into container at /data/games.json
├── Dockerfile
├── docker-compose.yml
└── entrypoint.sh       # Seeds /data/games.json from bundled copy on first start
```

## Data file — games.json

```json
[
  {
    "name": "Game Title",
    "group": "Watching",
    "url": "https://f95zone.to/threads/...",
    "scraped_version": "1.0.0",
    "release_date": "2024-11-15",
    "status": "Active",
    "active": true,
    "needs_update": false,
    "update_count": 0,
    "last_updated": null,
    "error": null
  }
]
```

`update_count` increments each time a scan finds a new version. Clicking **Mark as Updated** resets it to 0.

## F95zone cookie

F95zone requires a logged-in session to read thread content. Set the `F95_COOKIE` environment variable to the value of your `xf_user` cookie (get it from browser DevTools → Application → Cookies → f95zone.to).

Add it to `docker-compose.yml`:

```yaml
environment:
  - F95_COOKIE=your_xf_user_cookie_value
```

Note: this is not necessary.  There's actually nothing in the current build that would even use anything from a logged in session.


## Running with Docker

```bash
docker compose up --build
```

Open `http://localhost:8765`.

`data/games.json` on the host is bind-mounted to `/data/games.json` in the container and survives restarts. On first start, if the file is missing, `entrypoint.sh` seeds it from the copy bundled into the image.

## Exporting to a NAS (e.g. Synology)

```bash
# Save image
docker save checkrenpy-checkrenpy -o checkrenpy.tar

# Copy tar to NAS, then on the NAS:
docker load -i checkrenpy.tar
```

Create a `docker-compose.yml` on the NAS pointing volumes at a local path:

```yaml
services:
  checkrenpy:
    image: checkrenpy-checkrenpy
    ports:
      - "8765:8765"
    volumes:
      - /volume1/docker/checkrenpy/data:/data
    environment:
      - F95_COOKIE=your_cookie_here
    restart: unless-stopped
```

## Running locally (dev)

```bash
cd backend
uv run uvicorn app:app --host 0.0.0.0 --port 8765 --reload
```

Set `GAMES_JSON` to override the default `/data/games.json` path:

```bash
GAMES_JSON=../data/games.json uv run uvicorn app:app --port 8765 --reload
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/games` | Return all games |
| POST | `/games` | Add a game (name, group, url) |
| DELETE | `/games/{name}` | Remove a game |
| PATCH | `/games/{name}` | Update arbitrary fields |
| POST | `/games/{name}/played` | Mark as updated — resets needs_update and update_count |
| POST | `/games/{name}/toggle-active` | Toggle active flag |
| POST | `/scan` | Start bulk scan (active games only) |
| POST | `/scan/{name}` | Scan one game |
| GET | `/scan/stream` | SSE stream of scan progress events |

## Dependencies

- Python: `fastapi`, `uvicorn[standard]`, `requests`, `beautifulsoup4`
- Frontend: vanilla HTML/CSS/JS — no framework
