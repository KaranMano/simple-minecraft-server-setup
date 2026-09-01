#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SERVER_DIR="$ROOT_DIR/server"
PAPER_VERSION=${PAPER_VERSION:-26.2}
USER_AGENT=${USER_AGENT:-"minecraft-paper-setup/1.0"}

command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required." >&2; exit 1; }

if [ -z "${PAPER_URL:-}" ]; then
  BUILDS_URL="https://fill.papermc.io/v3/projects/paper/versions/${PAPER_VERSION}/builds"
  BUILDS_RESPONSE=$(curl --fail --silent --show-error --location \
    --header "User-Agent: $USER_AGENT" "$BUILDS_URL")

  REQUESTED_BUILD=${PAPER_BUILD:-}
  PAPER_BUILD=$(printf '%s' "$BUILDS_RESPONSE" | jq -r --arg requested_build "$REQUESTED_BUILD" \
    'first(.[] | select(.channel == "STABLE" and ($requested_build == "" or (.id | tostring) == $requested_build)) | .id) // "null"')
  PAPER_URL=$(printf '%s' "$BUILDS_RESPONSE" | jq -r \
    --arg requested_build "$REQUESTED_BUILD" \
    'first(.[] | select(.channel == "STABLE" and ($requested_build == "" or (.id | tostring) == $requested_build)) | .downloads."server:default".url) // "null"')

  if [ "$PAPER_BUILD" = "null" ] || [ "$PAPER_URL" = "null" ]; then
    echo "No stable Paper build found for Minecraft $PAPER_VERSION." >&2
    exit 1
  fi

  echo "Latest stable Paper build for $PAPER_VERSION: $PAPER_BUILD"
else
  PAPER_BUILD=${PAPER_BUILD:-custom}
fi

PAPER_JAR=$(basename "$PAPER_URL")

mkdir -p "$SERVER_DIR"

if [ ! -f "$SERVER_DIR/server.properties" ]; then
  cp "./server.properties.example" "$SERVER_DIR/server.properties"
  echo "Created server/server.properties from the example."
fi

if [ ! -f "$SERVER_DIR/eula.txt" ]; then
  if [ "${EULA:-false}" != "true" ]; then
    echo "Set EULA=true when running setup after accepting the Minecraft EULA." >&2
    echo "Example: EULA=true ./scripts/setup.sh" >&2
    exit 1
  fi
  printf '%s\n' 'eula=true' > "$SERVER_DIR/eula.txt"
fi

if [ ! -f "$SERVER_DIR/$PAPER_JAR" ]; then
  echo "Downloading $PAPER_JAR..."
  curl --fail --location --show-error --output "$SERVER_DIR/$PAPER_JAR" "$PAPER_URL"
fi

mkdir -p "$SERVER_DIR/logs" "$SERVER_DIR/backups" "$SERVER_DIR/scripts"
chmod 755 "$ROOT_DIR/scripts/setup.sh" "$SERVER_DIR/scripts/backup.sh" 2>/dev/null || true
echo "Minecraft server files are ready. Start with: docker compose up -d --build"