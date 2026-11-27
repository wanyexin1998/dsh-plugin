#!/usr/bin/env bash
# Run on a local Linux Docker host. The only network is the fixture's loopback.
set -euo pipefail
base=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
tag="relay-rebuild-$$"
image=${NODE_IMAGE:-node:24-trixie-slim}
gateway="$tag-gateway"
seat="$tag-seat"
cleanup() {
  docker rm -f "$seat" "$gateway" >/dev/null 2>&1 || true
  docker volume rm "$tag-paired" "$tag-unpaired" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT
if [[ -n ${SEAT_FIXTURE_BUNDLE:-} ]]; then
  cp "$SEAT_FIXTURE_BUNDLE" "$work/fixture.cjs"
else
  "$base/node_modules/.bin/esbuild" "$base/test/fixtures/rebuilt-seat.mjs" --platform=node --bundle --format=cjs --outfile="$work/fixture.cjs"
fi
cp "$base/scripts/verify-seat-rebuild.mjs" "$work/"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -addext subjectAltName=IP:127.0.0.1 -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
common=(-v "$work:/fixture:ro" -e NODE_EXTRA_CA_CERTS=/fixture/cert.pem)
wait_log() {
  for ((i=0;i<60;i++)); do
    if docker logs "$1" 2>&1 | grep -F "$2" >/dev/null; then return; fi
    sleep .5
  done
  docker logs "$1"
  return 1
}
docker run --network none -d --name "$gateway" "${common[@]}" "$image" node /fixture/fixture.cjs gateway >/dev/null
wait_log "$gateway" GATEWAY_READY
docker run --init --network none -d --name "$seat" "${common[@]}" -v "$tag-unpaired:/state" "$image" node /fixture/fixture.cjs legacy >/dev/null
wait_log "$seat" LEGACY_READY
docker run --rm --network none "${common[@]}" -v "$tag-unpaired:/state" "$image" node /fixture/fixture.cjs legacy-contender
docker rm -f "$seat" >/dev/null
for mode in paired unpaired; do
  volume="$tag-$mode"
  args=(--network "container:$gateway" "${common[@]}" -v "$volume:/state")
  action=idle
  if [[ $mode == paired ]]; then action=pair; fi
  docker run -d --name "$seat" "${args[@]}" "$image" node /fixture/fixture.cjs "$action" >/dev/null
  wait_log "$seat" 'START 1 disconnected'
  if [[ $mode == paired ]]; then wait_log "$seat" PAIRED; fi
  dir=$(docker exec "$seat" sh -ec 'cd /state/profiles/* && pwd')
  before=$(docker exec "$seat" node /fixture/verify-seat-rebuild.mjs before "$dir")
  docker run --rm "${args[@]}" "$image" node /fixture/fixture.cjs contender
  docker kill "$seat" >/dev/null
  docker rm "$seat" >/dev/null
  if [[ $mode == paired ]]; then
    # Simulate a reclaimer that died after unlinking the owner but before unlinking the canonical lock.
    docker run --rm "${args[@]}" "$image" node -e 'const fs=require("node:fs"), path=require("node:path"), dir=process.argv[1]; const owner=JSON.parse(fs.readFileSync(path.join(dir,"receiver.lock"))).ownerFile; fs.unlinkSync(path.join(dir,owner))' "$dir"
  fi
  docker run -d --name "$seat" "${args[@]}" "$image" node /fixture/fixture.cjs idle >/dev/null
  docker exec "$seat" node /fixture/verify-seat-rebuild.mjs after "$dir" "$before"
  if [[ $mode == unpaired ]]; then
    docker kill --signal USR2 "$seat" >/dev/null
    wait_log "$seat" PAIRED
    bound=$(docker exec "$seat" node /fixture/verify-seat-rebuild.mjs before "$dir")
    [[ $bound =~ ^[0-9a-f]{64}$ ]]
    docker exec "$seat" node /fixture/verify-seat-rebuild.mjs after "$dir" "$bound"
  fi
  echo "$mode rebuild PASS"
  docker rm -f "$seat" >/dev/null
done
