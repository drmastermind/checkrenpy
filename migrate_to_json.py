# ------------------------------------------------------------
# Script: migrate_to_json.py
# Purpose: One-time migration from per-folder .url/.version/.last files
#          into the games.json format used by the new web GUI.
# Author: David Scott
# Created: 2026-04-26
# Updated: 2026-04-26
#
# Version History:
#   v1.0 - Initial creation.
#   v1.1 - Corrected metadata file paths to <folder>/.url etc (not prefixed).
#   v1.2 - Read NeedToUpdate file per directory to set needs_update/update_count.
#
# Dependencies:
#   - Python 3.8+  (stdlib only)
#
# Notes:
#   - Run once before starting the web app for the first time.
#   - Output written to ./data/games.json (created if missing).
#   - Existing games.json is NOT overwritten; script aborts if it exists.
#   - NeedToUpdate line format:
#       <name padded>  Version: x  Modified: yyyy-mm-dd  URL: https://...
# ------------------------------------------------------------

import json
import sys
from collections import Counter
from pathlib import Path

# -----------------------------
# CONFIGURATION
# -----------------------------

WATCH_DIR = Path("/home/share/Software/Games/RenPY/Watching")
HOLD_DIR  = Path("/home/share/Software/Games/RenPY/hold")

OUTPUT_FILE = Path("./data/games.json")

SOURCES = [
    (WATCH_DIR, "Watching"),
    (HOLD_DIR,  "hold"),
]

# -----------------------------
# HELPERS
# -----------------------------

def read_file(path: Path) -> str:
    """Return stripped file contents, or empty string if file missing."""
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""


def load_update_counts(directory: Path) -> Counter:
    """
    Parse <directory>/NeedToUpdate and return a Counter of game name -> line count.
    Game name is the text before the first 'Version:' token, stripped.
    """
    counts: Counter = Counter()
    ntu_path = directory / "NeedToUpdate"
    try:
        lines = ntu_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return counts

    for line in lines:
        line = line.strip()
        if not line:
            continue
        # Name is everything before the first occurrence of "Version:"
        if "Version:" in line:
            name = line.split("Version:")[0].strip()
        else:
            name = line.strip()
        if name:
            counts[name] += 1

    return counts


def game_entry(folder: Path, group: str, update_counts: Counter) -> dict:
    url               = read_file(folder / ".url")
    installed_version = read_file(folder / ".version")
    last_updated_raw  = read_file(folder / ".last")
    last_updated      = last_updated_raw if last_updated_raw else None

    count        = update_counts[folder.name]
    needs_update = count > 0

    return {
        "name":              folder.name,
        "group":             group,
        "url":               url,
        "installed_version": installed_version or None,
        "scraped_version":   None,
        "release_date":      None,
        "status":            "Active",
        "needs_update":      needs_update,
        "update_count":      count,
        "last_updated":      last_updated,
        "error":             None,
    }


# -----------------------------
# MAIN
# -----------------------------

def main():
    if OUTPUT_FILE.exists():
        print(f"ERROR: {OUTPUT_FILE} already exists. Delete it first if you want to re-migrate.")
        sys.exit(1)

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)

    games = []
    for directory, group in SOURCES:
        if not directory.exists():
            print(f"WARNING: directory not found, skipping: {directory}")
            continue

        update_counts = load_update_counts(directory)
        print(f"  NeedToUpdate: {sum(update_counts.values())} entries across {len(update_counts)} games in [{group}]")

        folders = sorted(p for p in directory.iterdir() if p.is_dir())
        for folder in folders:
            entry = game_entry(folder, group, update_counts)
            if not entry["url"]:
                print(f"  SKIP (no .url): {folder.name}")
                continue
            flag = " [needs update x{}]".format(entry["update_count"]) if entry["needs_update"] else ""
            print(f"  OK [{group}] {folder.name}{flag}")
            games.append(entry)

    tmp = OUTPUT_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(games, indent=2, default=str), encoding="utf-8")
    tmp.rename(OUTPUT_FILE)

    print(f"\nMigrated {len(games)} games -> {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
