FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY panel/frontend/package*.json ./
RUN npm ci
COPY panel/frontend ./
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY panel/backend/package*.json ./
RUN npm ci --omit=dev
COPY panel/backend/server.js ./server.js
COPY --from=frontend /build/frontend/dist ./dist
CMD ["node", "server.js"]
