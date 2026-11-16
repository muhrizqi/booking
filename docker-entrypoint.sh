#!/bin/sh
set -e
mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR" 2>/dev/null || true
exec su-exec node "$@"
