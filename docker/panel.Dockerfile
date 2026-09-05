FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY panel/frontend/package*.json ./
RUN npm ci
COPY panel/frontend ./
RUN npm run build

FROM eclipse-temurin:25-jre
RUN apt-get update \
	&& apt-get install --no-install-recommends -y bash gosu procps \
	&& rm -rf /var/lib/apt/lists/* \
	&& if ! getent passwd 1000 >/dev/null; then useradd --create-home --uid 1000 --shell /usr/sbin/nologin minecraft; fi \
	&& mkdir -p /app/server /app/scripts /panel-data \
	&& chown -R 1000:1000 /app /panel-data

# Reuse the official Node runtime while keeping Java as the base runtime.
COPY --from=frontend /usr/local/bin/node /usr/local/bin/node
COPY --from=frontend /usr/local/bin/npm /usr/local/bin/npm
COPY --from=frontend /usr/local/bin/npx /usr/local/bin/npx
COPY --from=frontend /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY panel/backend/package*.json /app/
WORKDIR /app
RUN /usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js install --omit=dev --prefix /app
COPY panel/backend/server.js /app/server.js
COPY --from=frontend /build/frontend/dist /app/dist
COPY scripts /app/scripts
COPY docker/combined-entrypoint.sh /usr/local/bin/combined-entrypoint.sh
RUN chown -R 1000:1000 /app
VOLUME ["/panel-data"]
RUN chmod 755 /usr/local/bin/combined-entrypoint.sh
USER root
ENV MINECRAFT_DIR=/app/server \
	DATA_FILE=/panel-data/.panel-users.json \
	PUBLIC_DIR=/app/dist \
	PATH=/usr/local/bin:/usr/bin:/bin
ENTRYPOINT ["/usr/local/bin/combined-entrypoint.sh"]
