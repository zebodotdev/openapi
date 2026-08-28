# Zebo Commerce API

This repository contains the public, machine-readable contract and ready-to-run HTTP collections for the Zebo Commerce API.

## Contents

- [`commerce.yml`](commerce.yml) — the public OpenAPI 3.0.3 specification.
- [`call/`](call/) — Insomnia v5.1 collections covering the public API, including a safe hosted-checkout quickstart.

The published files contain no credentials, cookies, private infrastructure details, or live capability URLs.

## Use the OpenAPI specification

Import `commerce.yml` into any OpenAPI 3.0-compatible client, generator, or validator. The production server URL is declared in the specification.

Validate the specification with:

```sh
npx --yes @redocly/cli@latest lint commerce.yml
```

## Use the Insomnia collections

Follow [`call/README.md`](call/README.md) to import the collections, configure a private environment, or run the checkout quickstart with Inso CLI. Keep API keys in a private Insomnia environment, shell environment, or supported external vault; never commit them to this repository.

Validate every Insomnia artifact against the published Insomnia v5.1 schema with:

```sh
cd call
./scripts/validate.sh
```

## License

Released under the [MIT License](LICENSE).
