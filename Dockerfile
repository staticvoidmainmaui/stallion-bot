FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production TZ=America/New_York \
    DB_PATH=/app/data/stallion.db AUTH_DIR=/app/data/auth
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY roster.json ./roster.json
# WhatsApp login + SQLite live here. Mount ONE persistent volume at /app/data,
# or you'll have to re-scan the QR on every deploy.
VOLUME ["/app/data"]
CMD ["npx", "tsx", "src/index.ts"]
