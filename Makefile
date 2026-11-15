.PHONY: test lint build validate

# `bin/bdc` runs the built CLI. `npm run build` has to come first.
export PATH := $(CURDIR)/bin:$(PATH)

test:
	npm run build
	npm test
	bdc validate examples/demo

lint:
	npm run lint

build:
	npm run build

validate: build
	bdc validate examples/demo
