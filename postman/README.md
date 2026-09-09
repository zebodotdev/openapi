# Inttegro API for Postman

This directory contains Postman Collection v2.1 equivalents of every public request in `insomnia/`. It includes 13 API-area collections, a shared environment, and a safe hosted-checkout workflow.

Every collection carries the Inttegro collection bundle version in
`info.version`, and the shared environment exposes the same value as
`collection_version`. Postman Collection 2.1 is the file-format version, not
the Inttegro collection bundle version.

## Import and configure

1. Import `00-environment.postman_environment.json` into Postman.
2. Import the API-area collection files you need, or import all 13.
3. Select the **Inttegro API** environment and set `api_key` locally. The published value is empty and marked secret.
4. Replace `idempotency_key` for each new logical operation. Reuse it only when retrying the same request with the same payload.

Create requests save returned resource IDs into the selected environment, so later requests and collections can reuse values such as `customer_id`, `payment_method_id`, and `order_id`. Capability URLs, OTPs, confirmation tokens, and API keys are secrets; never commit an exported environment containing real values.

## Safe checkout workflow

Import `workflows/checkout-quickstart.postman_collection.json` and run its two requests in order. It creates a finalized order, captures `order_id` and `checkout_url`, and looks the order up. It does not request or confirm payment.

You can also run it with Newman:

```sh
export INTTEGRO_API_KEY='replace-with-your-api-key'
export INTTEGRO_API_BASE_URL='https://api.inttegro.com'
export INTTEGRO_ORDER_NUMBER='POSTMAN-ORDER-001'
export INTTEGRO_IDEMPOTENCY_KEY='checkout-unique-stable-value'

npx newman run postman/workflows/checkout-quickstart.postman_collection.json \
  --environment postman/00-environment.postman_environment.json \
  --env-var "api_key=${INTTEGRO_API_KEY}" \
  --env-var "base_url=${INTTEGRO_API_BASE_URL}" \
  --env-var "order_number=${INTTEGRO_ORDER_NUMBER}" \
  --env-var "idempotency_key=${INTTEGRO_IDEMPOTENCY_KEY}" \
  --bail
```

Choose a new order number and idempotency key together for each new checkout. Keep both unchanged when retrying the same checkout after a timeout.

## Maintenance

Postman artifacts are generated from Insomnia and must not be edited directly. From the repository root, run:

```sh
npm run postman:generate
npm test
./postman/scripts/validate.sh
```

`npm test` fails if Postman is stale, if either client format does not cover every OpenAPI operation exactly once, or if request examples violate the OpenAPI request schemas.
