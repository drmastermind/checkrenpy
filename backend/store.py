# ------------------------------------------------------------
# Script: store.py
# Purpose: All reads and writes to games.json — single source of truth.
# Author: David Scott
# Created: 2026-04-26
# Updated: 2026-04-26
#
# Version History:
#   v1.0 - Initial creation.
#   v1.1 - Use RLock + private _load/_save so all public functions are
#           serialised; fixes concurrent-write corruption on Windows.
#   v1.2 - Detect UTF-16 BOM in _load(); original games.json from Windows
#           is UTF-16 LE; subsequent writes use UTF-8.
#
# Dependencies:
#   - Python 3.8+  (stdlib only)
#
# Notes:
#   - DATA_FILE defaults to /data/games.json (Docker volume mount).
#     Override with GAMES_JSON env var for local dev.
#   - All public functions acquire _lock so concurrent scans cannot
#     interleave reads and writes.
# ------------------------------------------------------------

import json
import os
import threading
from pathlib import Path

# -----------------------------
# CONFIGURATION
# -----------------------------

DATA_FILE = Path(os.getenv("GAMES_JSON", "/data/games.json"))
_lock = threading.RLock()

# -----------------------------
# PRIVATE I/O  (call only while holding _lock)
# -----------------------------

def _load() -> list[dict]:
    try:
        raw = DATA_FILE.read_bytes()
        # Detect UTF-16 LE/BE BOM; original games.json may be UTF-16 from Windows.
        # After first _save() the file will be UTF-8.
        if raw[:2] in (b'\xff\xfe', b'\xfe\xff'):
            text = raw.decode('utf-16')
        else:
            text = raw.decode('utf-8-sig')
        return json.loads(text)
    except FileNotFoundError:
        return []


def _save(games: list[dict]) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(
        json.dumps(games, indent=2, default=str),
        encoding="utf-8",
        newline="\n",
    )

# -----------------------------
# PUBLIC API
# -----------------------------

def load_games() -> list[dict]:
    with _lock:
        return _load()


def save_games(games: list[dict]) -> None:
    with _lock:
        _save(games)


def add_game(name: str, group: str, url: str) -> dict:
    with _lock:
        games = _load()
        if any(g["name"] == name for g in games):
            raise ValueError(f"Game already exists: {name}")
        entry = {
            "name": name,
            "group": group,
            "url": url,
            "installed_version": None,
            "scraped_version": None,
            "release_date": None,
            "status": "Active",
            "active": True,
            "needs_update": False,
            "update_count": 0,
            "last_updated": None,
            "error": None,
        }
        games.append(entry)
        _save(games)
    return entry


def remove_game(name: str) -> None:
    with _lock:
        games = _load()
        filtered = [g for g in games if g["name"] != name]
        if len(filtered) == len(games):
            raise KeyError(f"Game not found: {name}")
        _save(filtered)


def update_game(name: str, fields: dict) -> dict:
    with _lock:
        games = _load()
        for game in games:
            if game["name"] == name:
                game.update(fields)
                _save(games)
                return game
    raise KeyError(f"Game not found: {name}")


def mark_played(name: str) -> dict:
    return update_game(name, {"needs_update": False, "update_count": 0})
