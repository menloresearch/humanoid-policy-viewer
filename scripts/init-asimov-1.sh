#!/usr/bin/env bash
# Checks out the asimov-1 submodule with only sim-model/ on disk. The repo also
# carries CAD and electrical files that would otherwise be copied into dist/.
# Safe to re-run.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

path=public/examples/scenes/asimov-1

git submodule update --init --depth 1 --filter=blob:none "$path"
git -C "$path" sparse-checkout set --no-cone '/sim-model/'

test -f "$path/sim-model/xmls/asimov_1.xml"
