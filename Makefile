.PHONY: test lint build validate

test:
	npm run build
	npm test
	./bin/bdc validate examples/demo

lint:
	npm run lint

build:
	npm run build

validate: build
	./bin/bdc validate examples/demo
