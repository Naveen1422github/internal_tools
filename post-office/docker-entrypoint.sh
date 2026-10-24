#!/bin/sh
# The post office container's entrypoint (see DEPLOY.md).
# It never runs `init`: a fresh office starts a fresh note counter, and the
# team's laptops would get numbers that are already taken. The data must come
# from the old office: a volume that already holds store.db, or one time only,
# COLLAB_OFFICE_BOOTSTRAP (base64 of `collab-post-office bundle`'s .tgz).
set -eu

DATA="${COLLAB_OFFICE_DATA:-/data}"
APP="${COLLAB_OFFICE_APP:-/app}"
BOOTSTRAP="${COLLAB_OFFICE_BOOTSTRAP:-}"

if [ -f "$DATA/store.db" ]; then
  if [ -n "$BOOTSTRAP" ]; then
    echo "collab-post-office: $DATA/store.db already exists, so COLLAB_OFFICE_BOOTSTRAP was ignored."
    echo "collab-post-office: remove that variable now: it holds the office's private key."
  fi
elif [ -n "$BOOTSTRAP" ]; then
  echo "collab-post-office: no store.db in $DATA; unpacking COLLAB_OFFICE_BOOTSTRAP (one time)"
  mkdir -p "$DATA"
  # Unpack beside the data, then move only the four known files, store.db last:
  # a half-finished unpack never looks like a ready office.
  TMP="$DATA/.bootstrap.$$"
  rm -rf "$TMP"
  mkdir -p "$TMP"
  if ! printf '%s' "$BOOTSTRAP" | base64 -d | tar -xzf - -C "$TMP"; then
    rm -rf "$TMP"
    echo "collab-post-office: COLLAB_OFFICE_BOOTSTRAP is not a base64 .tgz from \`collab-post-office bundle\`" >&2
    exit 1
  fi
  for f in store.db cert.pem key.pem config.json; do
    if [ ! -f "$TMP/$f" ]; then
      rm -rf "$TMP"
      echo "collab-post-office: the bootstrap bundle has no $f; make it again with \`collab-post-office bundle\`" >&2
      exit 1
    fi
  done
  mv "$TMP/cert.pem" "$TMP/key.pem" "$TMP/config.json" "$DATA/"
  chmod 600 "$DATA/key.pem"
  mv "$TMP/store.db" "$DATA/store.db"
  rm -rf "$TMP"
  echo "collab-post-office: unpacked. Remove COLLAB_OFFICE_BOOTSTRAP now: it holds the office's private key."
else
  echo "collab-post-office: no post office in $DATA (no store.db)." >&2
  echo "collab-post-office: this container never creates one: a new office would hand out note numbers the team already used." >&2
  echo "collab-post-office: move the existing office here (DEPLOY.md): put its data dir on the volume, or set COLLAB_OFFICE_BOOTSTRAP once." >&2
  exit 1
fi

exec node "$APP/post-office/dist/bin.js" serve --data "$DATA" "$@"
