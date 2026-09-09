#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# 1. Check if logged in to npm; if not, prompt to log in.
if ! npm whoami >/dev/null 2>&1; then
  gum style --foreground 220 "Not logged in to npm. Starting login..."
  npm login
  if ! npm whoami >/dev/null 2>&1; then
    gum style --foreground 1 "Login failed. Aborting."
    exit 1
  fi
fi
gum style --foreground 2 "Logged in as: $(npm whoami)"

# 2. Read current version and compute the default (patch + 1).
current="$(node -p "require('./package.json').version")"
default="$(node -p "const v=require('./package.json').version.split('.'); v[2]=Number(v[2])+1; v.join('.')")"
gum style --foreground 6 "Current version: $current"

# 3. Ask for the new version, defaulting to the bumped patch.
version="$(gum input --placeholder "$default" --prompt "New version > ")"
version="${version:-$default}"

# 4. Set the version, make a release commit, and create the tag in one step.
#    npm version fails if the version is unchanged or the tag already exists.
npm version "$version"

# 5. Publish, then push the tag to GitHub.
npm publish
git push origin "v$version"
gum style --foreground 2 "Published @sarthakpranesh/mcp-lazy-proxy@$version"
