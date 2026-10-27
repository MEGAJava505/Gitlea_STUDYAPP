# Local GitHub MVP - application image.
#
# Multi-stage build producing a small Next.js standalone runtime. The Docker
# build installs declared dependencies from package.json (this happens in the
# isolated build context, not in the developer worktree).

# --- deps: install declared dependencies ---
FROM node:24-alpine AS deps
WORKDIR /app
# Use the committed lockfile. better-sqlite3 13 requires Node >=22 and ships NAPI binaries.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- build: compile the Next.js app into standalone output ---
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NODE_ENV=production
ENV NODE_ENV=$NODE_ENV
RUN npm run build

# --- run: minimal standalone runtime ---
FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# Copy the standalone server plus static assets.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/drizzle ./drizzle
EXPOSE 3000
# The standalone server entrypoint.
CMD ["node", "server.js"]
