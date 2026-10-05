#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}
DATA_DIR=${DATA_DIR:-/data}

mkdir -p "$DATA_DIR/dem" "$DATA_DIR/uploads"
chown -R "$PUID":"$PGID" "$DATA_DIR"

exec gosu "$PUID":"$PGID" "$@"
