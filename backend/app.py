# ------------------------------------------------------------
# Script: app.py
# Purpose: FastAPI backend — API endpoints, SSE scan stream.
# Author: David Scott
# Created: 2026-04-26
# Updated: 2026-04-26
#
# Version History:
#   v1.0 - Initial creation.
#
# Dependencies:
#   - fastapi         uv add fastapi
#   - uvicorn         uv add uvicorn[standard]
#
# Notes:
#   - GAMES_JSON env var overrides the default /data/games.json path.
#   - Scan runs in a ThreadPoolExecutor; SSE events are pushed via asyncio Queue.
# ------------------------------------------------------------

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import AsyncGenerator

from typing import Any
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import store
import scanner

# -----------------------------
# APP SETUP
# -----------------------------

app = FastAPI(title="checkRenpy")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_executor = ThreadPoolExecutor(max_workers=4)

# Single shared queue for SSE events during a scan.
_scan_queue: asyncio.Queue | None = None

# -----------------------------
# MODELS
# -----------------------------

class NewGame(BaseModel):
    name: str
    group: str
    url: str

# -----------------------------
# GAME ENDPOINTS
# -----------------------------

@app.get("/games")
def get_games():
    return store.load_games()


@app.post("/games", status_code=201)
def post_game(body: NewGame):
    try:
        return store.add_game(body.name, body.group, body.url)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.delete("/games/{name}", status_code=204)
def delete_game(name: str):
    try:
        store.remove_game(name)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/games/{name}/played")
def played(name: str):
    try:
        return store.mark_played(name)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/games/{name}/move-to-hold")
def move_to_hold(name: str):
    try:
        return store.update_game(name, {"group": "hold"})
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/games/{name}/move-to-active")
def move_to_active(name: str):
    try:
        return store.update_game(name, {"group": "Watching"})
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.patch("/games/{name}")
def patch_game(name: str, body: dict[str, Any]):
    try:
        return store.update_game(name, body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/games/{name}/toggle-active")
def toggle_active(name: str):
    games = store.load_games()
    game = next((g for g in games if g["name"] == name), None)
    if not game:
        raise HTTPException(status_code=404, detail=f"Game not found: {name}")
    return store.update_game(name, {"active": not game.get("active", True)})

# -----------------------------
# SCAN ENDPOINTS
# -----------------------------

def _run_scan_one(game: dict, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue) -> None:
    """Worker: scan one game, save result, push SSE event."""
    result = scanner.scan_one(game)
    store.update_game(result["name"], result)
    event = json.dumps({"type": "result", "game": result})
    asyncio.run_coroutine_threadsafe(queue.put(event), loop)


@app.post("/scan")
async def scan_all():
    """Fire-and-forget bulk scan; subscribe to /scan/stream for live updates."""
    global _scan_queue
    games = [g for g in store.load_games() if g.get("active", True)]
    loop = asyncio.get_event_loop()
    _scan_queue = asyncio.Queue()
    queue = _scan_queue

    async def _run():
        futures = [
            loop.run_in_executor(_executor, _run_scan_one, g, loop, queue)
            for g in games
        ]
        await asyncio.gather(*futures)
        await queue.put(json.dumps({"type": "done"}))

    asyncio.create_task(_run())
    return {"queued": len(games)}


@app.post("/scan/{name}")
async def scan_one_game(name: str):
    games = store.load_games()
    game = next((g for g in games if g["name"] == name), None)
    if game is None:
        raise HTTPException(status_code=404, detail=f"Game not found: {name}")

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(_executor, scanner.scan_one, game)
    store.update_game(result["name"], result)
    return result


async def _sse_generator() -> AsyncGenerator[str, None]:
    global _scan_queue
    # Wait up to 5 s for a scan to start before giving up.
    for _ in range(50):
        if _scan_queue is not None:
            break
        await asyncio.sleep(0.1)

    queue = _scan_queue
    if queue is None:
        yield "data: {\"type\": \"error\", \"detail\": \"no scan running\"}\n\n"
        return

    while True:
        event = await queue.get()
        yield f"data: {event}\n\n"
        if json.loads(event).get("type") == "done":
            break


@app.get("/scan/stream")
async def scan_stream():
    return StreamingResponse(
        _sse_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )

# -----------------------------
# STATIC FILES (frontend)
# -----------------------------

import os
from pathlib import Path

_static = Path(__file__).parent.parent / "frontend"
if _static.is_dir():
    app.mount("/", StaticFiles(directory=str(_static), html=True), name="static")
