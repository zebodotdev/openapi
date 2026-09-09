# Inttegro API

This repository contains the public, machine-readable contract and ready-to-run HTTP collections for the Inttegro API.

## Contents

- [`commerce.yml`](commerce.yml) — the public OpenAPI 3.0.3 specification.
- [`insomnia/`](insomnia/) — Insomnia v5.1 collections covering the public API.
- [`postman/`](postman/) — equivalent Postman Collection v2.1 artifacts generated from Insomnia.

The published files contain no credentials, cookies, private infrastructure details, or live capability URLs.

This contract contains only operations intended for API consumers using documented public authentication. Service-only and operator-only routes do not belong in the specification or client collections.

## Versions

OpenAPI, Insomnia, and Postman are released as one collection bundle. The bundle version is declared by `info.version` and `info.x-inttegro-collection-version` in `commerce.yml`, exposed as `collection_version` in the shared client environment, and written to every generated Postman collection.

The contract test requires all representations to carry the same version. It also refuses to refresh the reviewed contract lock after an artifact changes unless the collection version is bumped. Insomnia schema 5.1 and Postman Collection 2.1 are file-format versions; they are independent of the Inttegro collection bundle version.

## Use the OpenAPI specification

Import `commerce.yml` into any OpenAPI 3.0-compatible client, generator, or validator. The production server URL is declared in the specification.

Validate the specification with:

```sh
npx --yes @redocly/cli@latest lint commerce.yml
```

## Use the Insomnia collections

Follow [`insomnia/README.md`](insomnia/README.md) to import the collections, configure a private environment, or run the checkout quickstart with Inso CLI. Keep API keys in a private Insomnia environment, shell environment, or supported external vault; never commit them to this repository.

Validate every Insomnia artifact against the published Insomnia v5.1 schema with:

```sh
cd insomnia
./scripts/validate.sh
```

## Use the Postman collections

Follow [`postman/README.md`](postman/README.md) to import the shared environment and API-area collections or run the safe checkout workflow with Newman.

Postman artifacts are generated from Insomnia. After changing an Insomnia collection, regenerate them with:

```sh
npm run postman:generate
```

## Keep OpenAPI and collections in sync

The repository treats `commerce.yml`, Insomnia, and Postman as one public contract. CI requires exact operation coverage, validates request examples against the OpenAPI schemas, checks that Postman is an exact generated counterpart of Insomnia, and verifies a reviewed digest that cannot be refreshed after a one-sided OpenAPI or Insomnia change.

Run the same contract gate locally:

```sh
npm ci
npm test
```

When intentionally changing the API contract, update OpenAPI and Insomnia, regenerate Postman, review them together, and refresh their shared digest:

```sh
npm run contract:update
npm test
```

## License

Released under the [MIT License](LICENSE).
