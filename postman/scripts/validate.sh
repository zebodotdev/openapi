#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
postman_dir=$(dirname -- "$script_dir")
schema_dir=$(mktemp -d "${TMPDIR:-/tmp}/inttegro-postman-schema.XXXXXX")
schema_file="$schema_dir/postman.collection.schema.2.1.json"

cleanup() {
  rm -f -- "$schema_file"
  rmdir -- "$schema_dir"
}
trap cleanup EXIT HUP INT TERM

curl -fsSL \
  https://schema.getpostman.com/json/collection/v2.1.0/collection.json \
  -o "$schema_file"

for collection_file in \
  "$postman_dir"/*.postman_collection.json \
  "$postman_dir"/workflows/*.postman_collection.json
do
  npx --yes ajv-cli@3 validate \
    --schema-id=id \
    -s "$schema_file" \
    -d "$collection_file"
done
