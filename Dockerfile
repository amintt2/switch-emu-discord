# Serveur + interface de l'Activité (déployé avec Coolify sur le VPS).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY serveur/package.json serveur/
COPY client/package.json client/
RUN npm ci
COPY serveur ./serveur
COPY client ./client
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/serveur ./serveur
COPY --from=build /app/client/dist ./client/dist
USER node
EXPOSE 3000
CMD ["node", "serveur/src/index.js"]
