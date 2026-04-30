#!/bin/bash

git add -A && git commit -m "feat!: restructure function-specific flags for CLI

- Move --function-invoke-opt from deploy to init as --used-in-feature
- Change value from UnstructuredChunking to SearchIndexChunking
- Add --test-with flag to function run (required)
- Remove --target-org from function run (not needed for functions)
- Make --used-in-feature optional with SearchIndexChunking default

BREAKING CHANGE: Command signatures changed for function init, deploy, and run

@W-22278901"