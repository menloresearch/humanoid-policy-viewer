#!/usr/bin/env bash
# Checks out the asimov-1 submodule with only sim-model/ on disk. The repo also
# carries CAD and electrical files that would otherwise be copied into dist/.
# The sparse pattern is set before the first checkout, so only sim-model/ is
# ever downloaded (about 16 MB instead of about 500 MB). Safe to re-run.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

path=public/examples/scenes/asimov-1

git submodule init "$path"

if [ ! -e "$path/.git" ]; then
  url=$(git config --get "submodule.$path.url")
  sha=$(git rev-parse "HEAD:$path")
  mkdir -p "$path"
  git -C "$path" init -q
  git -C "$path" remote add origin "$url"
  git -C "$path" sparse-checkout set --no-cone '/sim-model/'
  git -C "$path" fetch -q --depth 1 --filter=blob:none origin "$sha"
  git -C "$path" checkout -q --detach FETCH_HEAD
  # Move the clone's .git into .git/modules/, like a normal submodule.
  git submodule --quiet absorbgitdirs "$path"
fi

# Existing checkouts: trim to sim-model/ and move to the pinned commit.
git -C "$path" sparse-checkout set --no-cone '/sim-model/'
git submodule update --init --depth 1 --filter=blob:none "$path"

test -f "$path/sim-model/xmls/asimov_1.xml"
