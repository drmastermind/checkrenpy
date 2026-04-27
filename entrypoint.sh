#!/bin/sh
if [ ! -f /data/games.json ]; then
    cp /app/seed/games.json /data/games.json
fi
exec "$@"
cd .