# ---- frontend ----
FROM node:24-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
COPY shared/ ../shared/
RUN npm run build

# ---- backend ----
FROM node:24-slim AS backend
WORKDIR /build/backend
COPY backend/package.json ./
RUN npm install --no-audit --no-fund
COPY backend/ ./
COPY shared/ ../shared/
RUN npm run build

# ---- runtime ----
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=backend /build/backend/dist ./dist
COPY --from=frontend /build/frontend/dist ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
