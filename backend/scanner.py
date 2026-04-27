# ------------------------------------------------------------
# Script: scanner.py
# Purpose: Pure scraping logic — no file I/O. Returns dicts only.
# Author: David Scott
# Created: 2026-04-26
# Updated: 2026-04-26
#
# Version History:
#   v1.0 - Initial creation (BeautifulSoup).
#   v1.1 - Switched to crawl4ai markdown; extracts Release Date by label.
#   v1.2 - Reverted to requests + BeautifulSoup; target Release Date label
#           directly in HTML so Thread Updated date is never picked up.
#
# Dependencies:
#   - requests        uv add requests
#   - beautifulsoup4  uv add beautifulsoup4
#
# Notes:
#   - F95zone requires a logged-in session cookie to read thread content.
#     Set the F95_COOKIE env var to the value of your xf_user cookie.
# ------------------------------------------------------------

import os
import re
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

# -----------------------------
# CONFIGURATION
# -----------------------------

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}

_cookie = os.getenv("F95_COOKIE", "")
_cookies_dict = {"xf_user": _cookie} if _cookie else {}

TIMEOUT = 30

# -----------------------------
# URL FOLLOWING
# -----------------------------

def check_url(url: str) -> str:
    resp = requests.get(url, headers=HEADERS, cookies=_cookies_dict,
                        timeout=TIMEOUT, allow_redirects=True)
    resp.raise_for_status()
    return resp.url

# -----------------------------
# PAGE FETCHING
# -----------------------------

def _fetch_soup(url: str) -> BeautifulSoup:
    resp = requests.get(url, headers=HEADERS, cookies=_cookies_dict,
                        timeout=TIMEOUT, allow_redirects=True)
    resp.raise_for_status()
    return BeautifulSoup(resp.text, "html.parser")

# -----------------------------
# EXTRACTION
# -----------------------------

def _extract_version(soup: BeautifulSoup) -> str | None:
    title = soup.find("title")
    text = title.get_text() if title else ""
    m = re.search(r'\[v([^\]]+)\]', text, re.IGNORECASE)
    return m.group(1).strip() if m else None


def _extract_status(soup: BeautifulSoup) -> str:
    title = soup.find("title")
    text = title.get_text() if title else ""
    if re.search(r'\[abandoned\]', text, re.IGNORECASE):
        return "Abandoned"
    if re.search(r'\[completed?\]', text, re.IGNORECASE):
        return "Complete"
    return "Active"


def _extract_release_date(soup: BeautifulSoup) -> str | None:
    # Find the <b> or <strong> tag whose text is "Release Date", then grab
    # the date from the following text node. This avoids picking up
    # "Thread Updated" which appears nearby on F95zone pages.
    for tag in soup.find_all(["b", "strong"]):
        if re.search(r'release\s+date', tag.get_text(), re.IGNORECASE):
            # Text immediately after the tag
            sibling = tag.next_sibling
            if sibling:
                text = str(sibling)
                m = re.search(r'(\d{4}-\d{2}-\d{2})', text)
                if m:
                    return m.group(1)
    return None

# -----------------------------
# PUBLIC SCRAPE FUNCTION
# -----------------------------

def scrape_game(url: str) -> dict:
    soup = _fetch_soup(url)
    return {
        "scraped_version": _extract_version(soup),
        "release_date":    _extract_release_date(soup),
        "status":          _extract_status(soup),
    }

# -----------------------------
# SCAN ONE GAME
# -----------------------------

def scan_one(game: dict) -> dict:
    result = dict(game)
    result["error"] = None

    try:
        final_url = check_url(game["url"])
        if final_url != game["url"]:
            result["url"] = final_url

        scraped = scrape_game(final_url)
        result.update(scraped)

        old_version = game.get("scraped_version")
        new_version = scraped.get("scraped_version")
        if new_version and new_version != old_version:
            result["update_count"] = game.get("update_count", 0) + 1
            result["needs_update"] = True
            result["last_updated"] = datetime.now(timezone.utc).isoformat()

    except Exception as exc:
        result["error"] = str(exc)

    return result
