# Local GitHub MVP - developer entry points.
#
# These targets mirror the npm scripts in package.json so that local
# development, CI, and the validation harness all use identical command names.
# Docker is NOT required for the non-compose targets.

COMPOSE ?= docker compose

.PHONY: help typecheck lint test test-watch build dev start \
	db-generate db-migrate db-seed \
	validate-gitea validate-gitea-negative \
	compose-up compose-down compose-config compose-up-validation compose-down-validation

help:
	@echo "typecheck            - npm run typecheck"
	@echo "lint                 - npm run lint"
	@echo "test                 - npm run test:unit"
	@echo "test-watch           - npm run test:unit:watch"
	@echo "build                - npm run build"
	@echo "dev                  - npm run dev"
	@echo "start                - npm run start"
	@echo "db-generate          - npm run db:generate"
	@echo "db-migrate           - npm run db:migrate"
	@echo "db-seed              - npm run db:seed"
	@echo "validate-gitea       - npm run validate:gitea (positive Phase 0 pass)"
	@echo "validate-gitea-negative - npm run validate:gitea:negative (negative Phase 0 pass)"
	@echo "compose-config       - docker compose config"
	@echo "compose-up           - docker compose up -d (app + gitea + proxy)"
	@echo "compose-down         - docker compose down"
	@echo "compose-up-validation - validation subset (gitea + proxy, no app)"
	@echo "compose-down-validation - validation subset down, wipe volumes"

typecheck:
	npm run typecheck

lint:
	npm run lint

test:
	npm run test:unit

test-watch:
	npm run test:unit:watch

build:
	npm run build

dev:
	npm run dev

start:
	npm run start

db-generate:
	npm run db:generate

db-migrate:
	npm run db:migrate

db-seed:
	npm run db:seed

validate-gitea:
	npm run validate:gitea

validate-gitea-negative:
	npm run validate:gitea:negative

compose-config:
	$(COMPOSE) config

compose-up:
	$(COMPOSE) up -d

compose-down:
	$(COMPOSE) down

compose-up-validation:
	$(COMPOSE) --profile validation up -d gitea proxy

compose-down-validation:
	$(COMPOSE) --profile validation down -v
