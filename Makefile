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
PROXY_HOST ?= localhost:5000

fork-test-image: version
	docker build -q -f fork/Dockerfile.test --build-arg BASE=$(FORK_TEST_BASE) -t frigate-fork-test .

test-py: fork-test-image
	docker run --rm frigate-fork-test $(TESTS)

check-py: fork-test-image
	docker run --rm --entrypoint python3 frigate-fork-test -u -m mypy --config-file frigate/mypy.ini frigate
	docker run --rm --entrypoint python3 frigate-fork-test generate_api_auth_spec.py --check

lint:
	ruff format --check frigate migrations docker *.py
	ruff check frigate migrations docker *.py
	cd web && npm run lint

format:
	ruff format frigate migrations docker *.py
	ruff check --fix frigate migrations docker *.py
	cd web && npm run lint:fix

test-web:
	cd web && npx vitest run

e2e:
	cd web && npm run e2e:build && npm run e2e

dev-web:
	cd web && PROXY_HOST=$(PROXY_HOST) npm run dev

.PHONY: fork-test-image test-py check-py lint format test-web e2e dev-web
