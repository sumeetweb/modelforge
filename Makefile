SHELL := /bin/sh
PYTHON := .venv/bin/python
COMPOSE := docker compose --env-file model-artifacts/routing.env
UV_CACHE_DIR ?= $(CURDIR)/.cache/uv
UV_PYTHON_INSTALL_DIR ?= $(CURDIR)/.cache/python
npm_config_cache ?= $(CURDIR)/.cache/npm
export UV_CACHE_DIR UV_PYTHON_INSTALL_DIR npm_config_cache
.PHONY: setup artifacts up down local test lint format smoke load-test synth security incidents
setup:
	uv sync --frozen --python 3.12
	npm ci
	npm run build
	$(MAKE) artifacts
artifacts:
	$(PYTHON) scripts/artifact_cli.py bootstrap
up: artifacts
	$(COMPOSE) up --build -d --wait
down:
	$(COMPOSE) down
local:
	$(PYTHON) scripts/run-local.py
test:
	npm run build
	$(PYTHON) -m pytest
	npm test
lint:
	.venv/bin/ruff check .
	.venv/bin/ruff format --check .
	npm run lint
format:
	.venv/bin/ruff format .
	.venv/bin/ruff check --fix .
	npm run format
smoke:
	$(PYTHON) scripts/smoke.py --url $(or $(URL),http://127.0.0.1:8080)
load-test:
	mkdir -p load-tests/results
	.venv/bin/locust -f load-tests/locustfile.py --headless --host $(or $(URL),http://127.0.0.1:8080) -u $(or $(USERS),20) -r 5 -t $(or $(DURATION),60s) --csv load-tests/results/local --html load-tests/results/local.html
synth:
	npm run synth -w @modelforge/infra
security:
	.venv/bin/pip-audit
	npm audit --omit=dev
incidents:
	$(PYTHON) -m pytest tests/integration/test_platform.py -v
