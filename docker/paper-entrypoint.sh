#!/bin/sh
set -eu

PAPER_JAR=$(find /data -maxdepth 1 -type f -name 'paper-*.jar' -printf '%f\n' | sort | head -n 1)
[ -n "$PAPER_JAR" ] || { echo "No Paper jar found in /data." >&2; exit 1; }

if [ -n "${MINECRAFT_RCON_PASSWORD:-}" ]; then
  sed -i "s|^rcon.password=.*$|rcon.password=${MINECRAFT_RCON_PASSWORD}|" /data/server.properties
  sed -i 's|^enable-rcon=.*$|enable-rcon=true|' /data/server.properties
fi

exec java -Xms1G -Xmx2G -jar "/data/$PAPER_JAR" --nogui
