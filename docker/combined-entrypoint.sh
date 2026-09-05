#!/bin/sh
set -eu

chown -R 1000:1000 /app/server /panel-data
exec /usr/sbin/gosu 1000:1000 node /app/server.js
