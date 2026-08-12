NODE ?= node

.PHONY: help install typecheck test test\:watch dev deploy tail gas-test lint

help:
	@echo 'Usage: make [target]'
	@echo ''
	@echo '  install       npm install in src/workers'
	@echo '  typecheck     tsc --noEmit (src/workers)'
	@echo '  test          vitest (src/workers)'
	@echo '  test:watch    vitest watch (src/workers)'
	@echo '  dev           wrangler dev (src/workers)'
	@echo '  deploy        wrangler deploy --keep-vars (src/workers)'
	@echo '  tail          wrangler tail (src/workers)'
	@echo '  gas-test      run legacy GAS test harness (plain Node)'

install:
	cd src/workers && npm install

typecheck:
	cd src/workers && npm run typecheck

test:
	cd src/workers && npm test

test\:watch:
	cd src/workers && npm run test:watch

dev:
	cd src/workers && npm run dev

deploy:
	cd src/workers && npm run deploy

tail:
	cd src/workers && npm run tail

# Google Apps Script tests (plain Node harness, no framework)
gas-test:
	$(NODE) src/gas/tests/run.js
