default_target: local

COMMIT_HASH := $(shell git log -1 --pretty=format:"%h"|tail -1)
VERSION = 0.18.0
IMAGE_REPO ?= ghcr.io/blakeblackshear/frigate
GITHUB_REF_NAME ?= $(shell git rev-parse --abbrev-ref HEAD)
BOARDS= #Initialized empty

include docker/*/*.mk

build-boards: $(BOARDS:%=build-%)

push-boards: $(BOARDS:%=push-%)

version:
	echo 'VERSION = "$(VERSION)-$(COMMIT_HASH)"' > frigate/version.py
	echo 'VITE_GIT_COMMIT_HASH=$(COMMIT_HASH)' > web/.env

local: version
	docker buildx build --target=frigate --file docker/main/Dockerfile . \
		--tag frigate:latest \
		--load

debug: version
	docker buildx build --target=frigate --file docker/main/Dockerfile . \
	    --build-arg DEBUG=true \
		--tag frigate:latest \
		--load

amd64:
	docker buildx build --target=frigate --file docker/main/Dockerfile . \
		--tag $(IMAGE_REPO):$(VERSION)-$(COMMIT_HASH) \
		--platform linux/amd64

arm64:
	docker buildx build --target=frigate --file docker/main/Dockerfile . \
		--tag $(IMAGE_REPO):$(VERSION)-$(COMMIT_HASH) \
		--platform linux/arm64

build: version amd64 arm64
	docker buildx build --target=frigate --file docker/main/Dockerfile . \
		--tag $(IMAGE_REPO):$(VERSION)-$(COMMIT_HASH) \
		--platform linux/arm64/v8,linux/amd64

push: push-boards
	docker buildx build --target=frigate --file docker/main/Dockerfile . \
		--tag $(IMAGE_REPO):${GITHUB_REF_NAME}-$(COMMIT_HASH) \
		--platform linux/arm64/v8,linux/amd64 \
		--push

run: local
	docker run --rm --publish=5000:5000 --publish=8971:8971 \
		--volume=${PWD}/config:/config frigate:latest

run_tests: local
	docker run --rm --workdir=/opt/frigate --entrypoint= frigate:latest \
		python3 -u -m unittest
	docker run --rm --workdir=/opt/frigate --entrypoint= frigate:latest \
		python3 -u -m mypy --config-file frigate/mypy.ini frigate

.PHONY: run_tests

# ---- fork inner-loop targets (see fork/README.md) ---------------------------
FORK_TEST_BASE ?= ghcr.io/blakeblackshear/frigate:0.18.0-rc2
# One test image per worktree, so parallel worktrees never test each other's sources.
FORK_TEST_IMAGE ?= frigate-fork-test-$(notdir $(CURDIR))
PROXY_HOST ?= localhost:5000
# The ruff version CI pins, run through uvx when available.
RUFF ?= $(if $(shell command -v uvx),uvx -q ruff@$(shell sed -n 's/^ruff *== *//p' docker/main/requirements-dev.txt),ruff)
# Written by `make wt`; worktrees without one use Playwright's default.
E2E_PORT ?= $(shell cat web/.e2e-port 2>/dev/null || echo 4173)
export E2E_PORT

fork-test-image: version
	docker build -q -f fork/Dockerfile.test --build-arg BASE=$(FORK_TEST_BASE) -t $(FORK_TEST_IMAGE) .

test-py: fork-test-image
	docker run --rm $(FORK_TEST_IMAGE) $(TESTS)

check-py: fork-test-image
	FORK_TEST_IMAGE=$(FORK_TEST_IMAGE) fork/scripts/py-checks.sh

lint:
	$(RUFF) format --check frigate migrations docker fork/scripts *.py
	$(RUFF) check frigate migrations docker fork/scripts *.py
	cd web && npm run lint

typecheck:
	cd web && npm run typecheck

format:
	$(RUFF) format frigate migrations docker fork/scripts *.py
	$(RUFF) check --fix frigate migrations docker fork/scripts *.py
	cd web && npm run lint:fix

test-web:
	cd web && npx vitest run

e2e:
	cd web && npm run e2e:build && npm run e2e

dev-web:
	cd web && PROXY_HOST=$(PROXY_HOST) npm run dev

check:
	fork/scripts/check.sh

check-fast:
	fork/scripts/check.sh --fast

wt:
	fork/scripts/wt.sh $(NAME)

promote:
	fork/scripts/promote.sh

demo-up:
	fork/demo/prepare-build.sh
	docker compose -f fork/demo/compose.yml up -d --build

demo-down:
	docker compose -f fork/demo/compose.yml down

demo-logs:
	docker compose -f fork/demo/compose.yml logs -f --tail=200

.PHONY: fork-test-image test-py check-py lint typecheck format test-web e2e dev-web check check-fast wt promote demo-up demo-down demo-logs
