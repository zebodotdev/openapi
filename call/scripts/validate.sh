#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
call_dir=$(dirname -- "$script_dir")
schema_dir=$(mktemp -d "${TMPDIR:-/tmp}/commerce-call-schema.XXXXXX")
schema_file="$schema_dir/insomnia.schema.5.1.json"

cleanup() {
  rm -f -- "$schema_file"
  rmdir -- "$schema_dir"
}
trap cleanup EXIT HUP INT TERM

curl -fsSL \
  https://raw.githubusercontent.com/Kong/insomnia/develop/schemas/insomnia.schema.5.1.json \
  -o "$schema_file"

npx --yes ajv-cli@5 validate \
  --spec=draft2020 \
  -s "$schema_file" \
  -d "$call_dir/**/*.insomnia.yaml"
