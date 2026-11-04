# Dueño: Persona 1. Imagen de la app. Contexto de build = raíz del repo.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD wget -qO- http://127.0.0.1:3000/instancia >/dev/null || exit 1

CMD ["node", "src/server.js"]
