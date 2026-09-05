#!/usr/bin/env bash
#
# Driver for the containerised development environment.
#
# Plain `docker build` / `docker run` rather than Compose, because the Compose
# plugin is not installed on this machine and three independent containers
# sharing one named volume do not need it. If you install it later, this script
# is still the documented entry point — the npm scripts call it.
#
#   ./docker/run.sh dev            start the dev server on :3100
#   ./docker/run.sh prod           production build on :3101
#   ./docker/run.sh seed [profile] reseed the running container
#   ./docker/run.sh shots [dir]    capture screenshots
#   ./docker/run.sh stop           stop both containers
#   ./docker/run.sh reset          stop and delete the seeded database
#   ./docker/run.sh build          rebuild the image
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=short-list-dev
SHOTS_IMAGE=short-list-shots
DEV_NAME=short-list-dev
PROD_NAME=short-list-prod
VOLUME=short-list-data
DEV_PORT="${DEV_PORT:-3100}"
PROD_PORT="${PROD_PORT:-3101}"
ENV_FILE="$REPO_ROOT/docker/env.dev"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

image_is_stale() {
  # Rebuild when the image is missing, or older than the inputs baked into it.
  docker image inspect "$IMAGE" >/dev/null 2>&1 || return 0
  local built
  built=$(docker image inspect -f '{{.Created}}' "$IMAGE")
  local built_epoch
  built_epoch=$(date -d "$built" +%s 2>/dev/null || echo 0)
  for f in "$REPO_ROOT/package-lock.json" "$REPO_ROOT/docker/Dockerfile.dev" \
           "$REPO_ROOT/docker/entrypoint.sh"; do
    [ -f "$f" ] || continue
    [ "$(stat -c %Y "$f")" -gt "$built_epoch" ] && return 0
  done
  return 1
}

build_image() {
  log "building $IMAGE"
  docker build -f "$REPO_ROOT/docker/Dockerfile.dev" -t "$IMAGE" "$REPO_ROOT"
}

ensure_image() {
  if image_is_stale; then build_image; else log "image $IMAGE is current"; fi
}

# `-it` only when there actually is a terminal: docker refuses to allocate one
# otherwise ("the input device is not a TTY"), which breaks CI and any
# backgrounded start.
tty_args() {
  if [ -t 0 ]; then printf '%s\0' -i -t; fi
}

# The repo is bind-mounted so host edits hot-reload. node_modules and .next are
# anonymous volumes layered on top, so the container's Linux binaries and build
# output never collide with the host tree.
#
# .env.local is masked with an empty file, and that is a security control, not
# tidiness: the host's .env.local holds the real TURSO_AUTH_TOKEN,
# BLOB_READ_WRITE_TOKEN and VERCEL_OIDC_TOKEN, and the bind mount would
# otherwise hand all three to the container. Next loads .env.local
# automatically, so masking is the only reliable way to keep production
# credentials out of a throwaway environment.
common_run_args() {
  printf '%s\0' \
    --rm \
    --env-file "$ENV_FILE" \
    -v "$REPO_ROOT:/app" \
    -v "/app/node_modules" \
    -v "/app/.next" \
    -v "$REPO_ROOT/docker/empty-env:/app/.env.local:ro" \
    -v "$VOLUME:/data"
}

cmd_dev() {
  ensure_image
  docker rm -f "$DEV_NAME" >/dev/null 2>&1 || true
  log "starting dev server on http://localhost:$DEV_PORT (passcode 1234)"
  local args=()
  while IFS= read -r -d '' a; do args+=("$a"); done < <(common_run_args)
  while IFS= read -r -d '' a; do args+=("$a"); done < <(tty_args)
  exec docker run "${args[@]}" \
    --name "$DEV_NAME" \
    -p "$DEV_PORT:3000" \
    ${SEED_PROFILE:+-e "SEED_PROFILE=$SEED_PROFILE"} \
    "$IMAGE"
}

cmd_prod() {
  ensure_image
  docker rm -f "$PROD_NAME" >/dev/null 2>&1 || true
  log "building for production, then serving http://localhost:$PROD_PORT"
  log "this is the run that enforces the Cache Components Suspense rules"
  local args=()
  while IFS= read -r -d '' a; do args+=("$a"); done < <(common_run_args)
  while IFS= read -r -d '' a; do args+=("$a"); done < <(tty_args)
  exec docker run "${args[@]}" \
    --name "$PROD_NAME" \
    -p "$PROD_PORT:3000" \
    -e NODE_ENV=production \
    ${SEED_PROFILE:+-e "SEED_PROFILE=$SEED_PROFILE"} \
    "$IMAGE" \
    sh -c 'npx next build && exec npx next start -H 0.0.0.0 -p 3000'
}

cmd_seed() {
  local profile="${1:-${SEED_PROFILE:-}}"
  docker ps --format '{{.Names}}' | grep -qx "$DEV_NAME" \
    || die "$DEV_NAME is not running — start it with 'npm run dev:docker'"

  if [ -n "$profile" ]; then
    log "reseeding as '$profile'"
    docker exec -e "SEED_PROFILE=$profile" "$DEV_NAME" \
      node scripts/seed/index.ts --profile "$profile" --out /data/dev.db
  else
    log "reseeding with the container's current profile"
    docker exec "$DEV_NAME" node scripts/seed/index.ts --out /data/dev.db
  fi

  # getListings and getListing both cacheLife('hours'), so without this the
  # reseed is invisible until the cache ages out.
  #
  # Node's fetch rather than curl: the slim image has no curl, and the route
  # wants `Authorization: Bearer <secret>` — it returns 401 for anything else.
  log "revalidating"
  docker exec "$DEV_NAME" node -e '
    const secret = process.env.REVALIDATE_SECRET
    const res = await fetch("http://localhost:3000/api/revalidate", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    })
    console.log(res.status, await res.text())
    if (!res.ok) process.exit(1)
  ' --input-type=module
  log "done — refresh the browser"
}

cmd_shots() {
  local out="${1:-.shots}"
  docker ps --format '{{.Names}}' | grep -qx "$DEV_NAME" \
    || die "$DEV_NAME is not running — start it with 'npm run dev:docker'"

  if ! docker image inspect "$SHOTS_IMAGE" >/dev/null 2>&1; then
    log "building $SHOTS_IMAGE (Playwright, ~1 GB — first run only)"
    docker build -f "$REPO_ROOT/docker/Dockerfile.shots" -t "$SHOTS_IMAGE" "$REPO_ROOT"
  fi

  mkdir -p "$REPO_ROOT/$out"
  log "capturing to $out/"
  docker run --rm \
    --network "container:$DEV_NAME" \
    -v "$REPO_ROOT/scripts:/work/scripts:ro" \
    -v "$REPO_ROOT/$out:/work/out" \
    --env-file "$ENV_FILE" \
    -e "SHOTS_BASE_URL=http://localhost:3000" \
    "$SHOTS_IMAGE" \
    node /work/scripts/shots.ts --out /work/out
}

cmd_stop() {
  log "stopping containers"
  docker rm -f "$DEV_NAME" "$PROD_NAME" >/dev/null 2>&1 || true
}

cmd_reset() {
  cmd_stop
  log "deleting the seeded database volume"
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  log "next start will reseed from scratch"
}

case "${1:-dev}" in
  dev) shift; cmd_dev "$@" ;;
  prod) shift; cmd_prod "$@" ;;
  seed) shift; cmd_seed "$@" ;;
  shots) shift; cmd_shots "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  reset) shift; cmd_reset "$@" ;;
  build) shift; build_image "$@" ;;
  *) die "unknown command '$1' — try dev, prod, seed, shots, stop, reset, build" ;;
esac
