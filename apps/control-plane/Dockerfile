FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY schema.sql ./
COPY src ./src
COPY bin ./bin

# Data volume for the SQLite store (users, keys, quotas)
ENV CONTROL_DB_PATH=/data/control.sqlite \
    HOST=0.0.0.0 \
    PORT=20140
RUN mkdir -p /data && chown -R node:node /data

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||20140)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 20140
CMD ["node", "src/server.js"]
