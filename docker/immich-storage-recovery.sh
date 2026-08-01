#!/bin/sh
set -eu

mounts="/mnt/media /mnt/library /mnt/backup /mnt/registry"

for mount_dir in $mounts; do
  if ! mountpoint -q "$mount_dir"; then
    echo "Mounting $mount_dir"
    timeout 20s mount "$mount_dir"
  fi
done

markers="
/mnt/library/immich/upload/.immich
/mnt/library/immich/library/.immich
/mnt/library/immich/thumbs/.immich
/mnt/library/immich/encoded-video/.immich
/mnt/library/immich/profile/.immich
/mnt/library/immich/backups/.immich
"

for marker in $markers; do
  if [ ! -f "$marker" ]; then
    echo "Required Immich storage marker is missing: $marker" >&2
    exit 1
  fi
done

if ! docker inspect immich_server >/dev/null 2>&1; then
  echo "immich_server does not exist yet; storage is ready"
  exit 0
fi

health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' immich_server)"
if [ "$health" != "healthy" ]; then
  echo "Storage is ready; restarting immich_server (current state: $health)"
  docker restart immich_server
fi
