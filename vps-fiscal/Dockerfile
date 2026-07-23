FROM node:20-alpine

WORKDIR /app

# Deps
COPY package.json ./
RUN npm install --omit=dev

# Código
COPY server.js ./
COPY nfce.js ./

# Certificado é montado como volume: /certs/store.pfx
ENV FISCAL_PFX_PATH=/certs/store.pfx
ENV PORT=3737

EXPOSE 3737

# Healthcheck simples
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "server.js"]
