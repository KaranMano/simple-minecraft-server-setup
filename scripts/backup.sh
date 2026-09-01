#!/usr/bin/env bash
set -euo pipefail

SERVER_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../server" && pwd)
BACKUP_DIR="$SERVER_DIR/backups"
WORLD_DIR="$SERVER_DIR/world"
TIMESTAMP=${BACKUP_TIMESTAMP:-$(date +%Y-%m-%d_%H-%M-%S)}
ARCHIVE="$BACKUP_DIR/world_$TIMESTAMP.tar.gz"

mkdir -p "$BACKUP_DIR"

case "${1:-create}" in
	create)
		[[ -d "$WORLD_DIR" ]] || { echo "World directory not found: $WORLD_DIR" >&2; exit 1; }
		tar -czf "$ARCHIVE" -C "$SERVER_DIR" world
		find "$BACKUP_DIR" -maxdepth 1 -type f -name 'world_*.tar.gz' -printf '%T@ %p\n' \
			| sort -nr | tail -n +4 | cut -d' ' -f2- | xargs -r rm -f
		printf '%s\n' "$ARCHIVE"
		;;
	restore)
		ARCHIVE_NAME=${2:-}
		[[ "$ARCHIVE_NAME" =~ ^world_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}\.tar\.gz$ ]] \
			|| { echo "Invalid backup name." >&2; exit 1; }
		ARCHIVE="$BACKUP_DIR/$ARCHIVE_NAME"
		[[ -f "$ARCHIVE" ]] || { echo "Backup not found: $ARCHIVE_NAME" >&2; exit 1; }
		[[ -d "$WORLD_DIR" ]] || { echo "World directory not found: $WORLD_DIR" >&2; exit 1; }
		mv "$WORLD_DIR" "$BACKUP_DIR/world_before_restore_$TIMESTAMP"
		tar -xzf "$ARCHIVE" -C "$SERVER_DIR"
		printf '%s\n' "$BACKUP_DIR/world_before_restore_$TIMESTAMP"
		;;
	*)
		echo "Usage: $0 [create|restore BACKUP_NAME]" >&2
		exit 2
		;;
esac
