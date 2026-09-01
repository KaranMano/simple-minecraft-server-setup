# Minecraft Server Panel

This is a local-only control panel for the Paper server in `server/`. The panel is split into `panel/backend` (Express API) and `panel/frontend` (React, Tailwind CSS, and Untitled UI components). It stores salted password hashes in the configured `DATA_FILE`.

## First run

Build the frontend and start the backend:

```sh
cd panel/frontend && npm run build
cd ../backend && JAVA_HOME='/path/to/java-25' PANEL_ADMIN_PASSWORD='choose-a-strong-password' npm start
```

Open http://127.0.0.1:8787 and sign in as `admin`. The first run creates the admin account. Do not commit panel user data.

`PANEL_ADMIN_PASSWORD` is used only on the first run. To reset the initial admin password, stop the panel, remove `.panel-users.json`, and start it again with a new password:

```sh
rm .panel-users.json
JAVA_HOME='/path/to/java-25' PANEL_ADMIN_PASSWORD='new-password' npm start
```

`JAVA_HOME` is optional. When set, the panel starts Paper with `${JAVA_HOME}/bin/java`; otherwise it uses `java` from `PATH`. The panel starts Paper with `-Xms1G -Xmx2G`, sends lifecycle commands through the process console, uses the existing local RCON settings, and invokes `scripts/backup.sh` for backups. It does not modify `worlds/`.

Run the syntax check with `npm run check`.

Backups are timestamped world archives in `server/backups/`. A manual or scheduled backup announces itself in-game, stops Paper, creates the archive, and starts Paper again when it was running. The panel keeps the newest three archives, shows the next backup at 04:00 local time, and can restore an archive; the current world is moved to a timestamped `world_before_restore_*` directory first.

## Docker Compose

The repository intentionally does not contain the Paper jar, a world, or generated server data. The minimum server files kept in Git are:

- `server/server.properties.example`, the safe configuration template
- `scripts/backup.sh`, used by the panel for backups and restores
- `scripts/setup.sh`, which creates local configuration and downloads Paper
- `docker/paper-entrypoint.sh`, which starts the downloaded Paper jar

Everything else under `server/` is ignored. Paper creates it, the setup script downloads it, or it is runtime data. This includes the jar, `eula.txt`, `server.properties`, logs, backups, libraries, plugins, and every world directory.

Install `curl`, accept the [Minecraft EULA](https://www.minecraft.net/eula), and prepare the server:

```sh
EULA=true ./scripts/setup.sh
```

The setup script downloads Paper 26.2 build 60 by default. Override `PAPER_VERSION`, `PAPER_BUILD`, or `PAPER_URL` when selecting another Paper release. To use an existing world, stop the stack, place the world directory under `server/`, and make sure its directory name matches `level-name` in `server/server.properties` (for example, set `level-name=my-world` and place it at `server/my-world/`). Leave the directory absent to let Paper generate a new world on first start.

Copy `.env.example` to `.env`, replace both placeholder passwords, and start both containers:

```sh
cp .env.example .env
docker compose up -d --build
```

The RCON password is injected into `server.properties` by the Minecraft container at startup, so it must match `MINECRAFT_RCON_PASSWORD` in `.env`. Do not commit `.env`, `server/server.properties`, the Paper jar, worlds, backups, logs, or generated server metadata; the root `.gitignore` covers these paths. Keep `scripts/backup.sh` tracked because the panel uses it for backups and restores.

The panel remains local at http://127.0.0.1:8787. Inside its container it binds to `0.0.0.0` so the published port can reach it; Docker publishes that port only on the host loopback interface. Paper runs in the `minecraft` container with a 3 GB memory and 2 CPU limit; the panel has a 512 MB memory and 1 CPU limit. The panel uses the Docker socket for lifecycle controls and container metrics, and reads Paper logs from the mounted server directory. Review the Docker socket exposure before using this on a multi-user machine because it grants the panel high control over the Docker host.

To stop the stack:

```sh
docker compose down
```