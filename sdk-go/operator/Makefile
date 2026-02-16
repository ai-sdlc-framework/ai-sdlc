.PHONY: all build test generate manifests deploy undeploy docker-build docker-push help

IMG ?= ghcr.io/ai-sdlc-framework/operator:latest

all: build

## Build
build: ## Build the operator binary
	go build -o bin/manager main.go

test: ## Run unit tests
	go test ./... -v -count=1

## Code Generation
generate: ## Generate DeepCopy implementations
	controller-gen object paths="./api/..."

manifests: ## Generate CRD manifests
	controller-gen crd paths="./api/..." output:crd:artifacts:config=config/crd/bases

## Deployment
deploy: manifests ## Deploy CRDs and operator to cluster
	kubectl apply -f config/crd/bases/
	kubectl apply -f config/rbac/
	kubectl apply -f config/manager/

undeploy: ## Remove operator and CRDs from cluster
	kubectl delete -f config/manager/ --ignore-not-found
	kubectl delete -f config/rbac/ --ignore-not-found
	kubectl delete -f config/crd/bases/ --ignore-not-found

## Docker
docker-build: ## Build Docker image
	docker build -t $(IMG) -f Dockerfile ..

docker-push: ## Push Docker image
	docker push $(IMG)

## Helm
helm-install: ## Install via Helm
	helm install ai-sdlc-operator ./helm --create-namespace -n ai-sdlc-system

helm-uninstall: ## Uninstall Helm release
	helm uninstall ai-sdlc-operator -n ai-sdlc-system

helm-template: ## Render Helm templates locally
	helm template ai-sdlc-operator ./helm -n ai-sdlc-system

## Help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'
