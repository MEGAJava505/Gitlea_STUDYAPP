# Local GitHub MVP - application image.
#
# Multi-stage build producing a small Next.js standalone runtime. The Docker
# build installs declared dependencies from package.json (this happens in the
# isolated build context, not in the developer worktree).

# --- deps: install declared dependencies ---
FROM node:20-alpine AS deps
WORKDIR /app
# package-lock.json is optional; npm falls back to resolving the declared
# semver ranges if no lockfile is present.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund || npm install --no-audit --no-fund

# --- build: compile the Next.js app into standalone output ---
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NODE_ENV=production
ENV NODE_ENV=$NODE_ENV
RUN npm run build

# --- run: minimal standalone runtime ---
FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# Copy the standalone server plus static assets.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE 3000
# The standalone server entrypoint.
CMD ["node", "server.js"]
