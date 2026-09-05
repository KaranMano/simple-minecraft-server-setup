# Minecraft Server Setup and Panel

This repository provides a Paper Minecraft server setup, Docker deployment, backup scripts, and an optional web control panel. The panel manages the Paper server in `server/` and is split into `panel/backend` (Express API) and `panel/frontend` (React and Ant Design). It stores salted password hashes in the configured `DATA_FILE`.

## First run

Install dependencies, build the frontend, and start the backend:

```sh
cd panel/frontend && npm ci && npm run build
cd ../backend && npm ci
JAVA_HOME='/path/to/java-25' PANEL_ADMIN_PASSWORD='choose-a-strong-password' npm start
```

Open http://127.0.0.1:8787 and sign in as `admin`. The first run creates the admin account. Do not commit panel user data.

`PANEL_ADMIN_PASSWORD` is used only on the first run. To reset the initial admin password, stop the panel, delete the generated user data file, and start it again with a new password. For a local run, remove `panel/backend/.panel-users.json`:

```sh
rm panel/backend/.panel-users.json
JAVA_HOME='/path/to/java-25' PANEL_ADMIN_PASSWORD='new-password' npm start
```

For Docker Compose, remove the named panel volume and recreate the stack. This deletes the stored users and asks for a new `PANEL_ADMIN_PASSWORD`:

```sh
docker compose down -v
docker compose up -d --build
```

`JAVA_HOME` is optional. When set, the panel starts Paper with `${JAVA_HOME}/bin/java`; otherwise it uses `java` from `PATH`. The panel starts Paper with `-Xms1G -Xmx2G`, sends lifecycle commands through the process console, uses the existing local RCON settings, and invokes `scripts/backup.sh` for backups and restores. It operates on the `server/world/` directory.

Run the syntax check with `npm run check`.

Backups are timestamped world archives in `server/backups/`. A manual or scheduled backup announces itself in-game, stops Paper, creates the archive, and starts Paper again when it was running. The panel keeps the newest three archives, shows the next backup at 04:00 local time, and can restore an archive; the current world is moved to a timestamped `world_before_restore_*` directory first.

## Docker Compose

The repository intentionally does not contain the Paper jar, a world, or generated server data. The setup files kept in Git are:

- `server.properties.example`, the safe configuration template
- `scripts/backup.sh`, used by the panel for backups and restores
- `scripts/setup.sh`, which creates local configuration and downloads Paper
- `docker/panel.Dockerfile`, which builds the combined Java and Node image

Everything else under `server/` is ignored. Paper creates it, the setup script downloads it, or it is runtime data. This includes the jar, `eula.txt`, `server.properties`, logs, backups, libraries, plugins, and every world directory.

Install `curl` and `jq`, accept the [Minecraft EULA](https://www.minecraft.net/eula), and prepare the server:

```sh
EULA=true ./scripts/setup.sh
```

The setup script downloads the latest stable Paper build for Minecraft `26.2` by default. Override `PAPER_VERSION`, `PAPER_BUILD`, or `PAPER_URL` when selecting another Paper release. To use an existing world, stop the stack, place the world directory under `server/`, and make sure its directory name matches `level-name` in `server/server.properties` (for example, set `level-name=my-world` and place it at `server/my-world/`). Leave the directory absent to let Paper generate a new world on first start.

Copy `.env.example` to `.env`, replace both placeholder passwords, and start the combined container:

```sh
cp .env.example .env
docker compose up -d --build
```

The combined `minecraft-panel` container runs both Node and Java as the unprivileged UID/GID `1000:1000`. Its image creates and owns the application directories and the named `panel-data` volume; no init container or Docker socket is required. The existing `./server` bind mount is used for the Paper jar, world, logs, and backups, so its files must be writable by UID 1000.

The RCON password is injected into `server.properties` by the combined container at startup, so it must match `MINECRAFT_RCON_PASSWORD` in `.env`. Do not commit `.env`, `server/server.properties`, the Paper jar, worlds, backups, logs, or generated server metadata; the root `.gitignore` covers these paths. Keep `scripts/backup.sh` tracked because the panel uses it for backups and restores.

The combined container publishes Minecraft on port 25565 and the panel locally at http://127.0.0.1:8787. The panel starts and controls the Java Paper process directly; there is no Docker API integration, Docker socket mount, proxy, or init container. Keep the panel bound to localhost and protect its credentials, especially before exposing it to other users or networks.

To stop the stack:

```sh
docker compose down
```