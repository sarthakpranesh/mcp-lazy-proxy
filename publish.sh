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

# 5. A version ending in "-<alphanumeric>" (e.g. 0.1.14-rc1) is a prerelease:
#    it needs an npm dist-tag and must not move Docker's ":latest".
prerelease=""
publish_args=()
if [[ "$version" == *-[A-Za-z0-9]* ]]; then
  prerelease=1
  tag="$(gum input --placeholder "rc" --prompt "Dist-tag > ")"
  publish_args=(--tag "${tag:-rc}")
fi
npm publish "${publish_args[@]}"
git push origin "v$version"
gum style --foreground 2 "Published @sarthakpranesh/mcp-lazy-proxy@$version to npm and github"

# 6. Log in to Docker Hub (interactive if no cached credentials), then build a
#    multi-arch image and push it. buildx emits a single manifest listing all
#    platforms, so amd64 and arm64 hosts can both pull a native image.
docker login
image="sarthakpranesh/mcp-lazy-proxy"
builder="mcp-lazy-proxy-builder"

# create (or reuse) a buildx builder with a docker-container driver, which is
# required to build images for platforms other than the host's own.
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container
fi
docker buildx use "$builder"

gum style --foreground 6 "Building multi-arch Docker image $image:$version (linux/amd64, linux/arm64) ..."

# only a stable release moves ":latest".
docker_tags=(-t "$image:$version")
if [[ -z "$prerelease" ]]; then
  docker_tags+=(-t "$image:latest")
fi
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  "${docker_tags[@]}" \
  --push \
  .
gum style --foreground 2 "Pushed multi-arch Docker image $image:$version${prerelease:+ (prerelease, :latest untouched)} to Docker Hub"
