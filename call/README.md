# Commerce API for Insomnia

This directory contains the public HTTP collections for the Commerce API. The files use Insomnia's native v5 YAML format and collectively cover all 117 HTTP operations in the public API reference. They deliberately contain no MCP client configuration, credentials, cookies, live capability URLs, or private infrastructure details.

## Collections

| File | Public API area |
| --- | --- |
| `00-environment.insomnia.yaml` | Shared connection, example-input, and chained runtime variables |
| `01-checkout.insomnia.yaml` | Hosted checkout and the complete order lifecycle |
| `02-customers.insomnia.yaml` | Customers |
| `03-payment-methods.insomnia.yaml` | Saved payment methods and their lifecycle |
| `04-catalog.insomnia.yaml` | Products and prices |
| `05-purchase-intents.insomnia.yaml` | Purchase intents and Buy links |
| `06-financial-accounts.insomnia.yaml` | Financial accounts |
| `07-balances.insomnia.yaml` | Balances and balance transactions |
| `08-payouts.insomnia.yaml` | Payout configuration and execution |
| `09-messaging.insomnia.yaml` | Notifications, schedules, broadcasts, and message templates |
| `10-otp.insomnia.yaml` | One-time passwords |
| `11-files.insomnia.yaml` | Files, file links, and third-party upload requests |
| `12-platform.insomnia.yaml` | Apps, API keys, and reference data |
| `13-refunds.insomnia.yaml` | Refund creation, lookup, and history |
| `workflows/checkout-quickstart.insomnia.yaml` | Safe create-and-lookup hosted checkout workflow with contract tests |

## Import and configure

1. Create or open one Insomnia project, then import `00-environment.insomnia.yaml` and the collection files you want to use into that same project.
2. Under the imported **Commerce API** global environment, create a sub-environment, mark it private, and select it before entering any real values. Private sub-environments are not synced or exported by Insomnia.
3. Set `api_key` in that private global environment. Keep the published base environment's `api_key` empty. For additional masking and encryption, use Insomnia's Secret variable type and update the bearer token field to reference `vault.api_key`; Secret variables use the vault namespace and are intentionally not portable in the public files.
4. Replace `idempotency_key` with a stable value for the logical operation you are about to perform. Reuse that value only when retrying the same operation with the same payload.
5. Fill any required input variables. Successful create requests save returned resource IDs into the active environment for the next request.

Insomnia resolves variables such as `{{ base_url }}` and `{{ order_id }}` from the selected global environment. After-response scripts save IDs there as well, so a customer created in the Customers collection is immediately available to Payment Methods or Checkout. See the official [environment documentation](https://developer.konghq.com/insomnia/environments/) for environment precedence and private sub-environments.

### Inso CLI and CI

Inso can override collection variables without creating a credential file. Export the credential only in the shell that runs Inso:

```sh
export ZEBO_API_KEY='replace-with-your-api-key'
export ZEBO_API_BASE_URL='https://api.inttegro.com'
export ZEBO_ORDER_NUMBER='INSOMNIA-ORDER-001'
export ZEBO_IDEMPOTENCY_KEY='checkout-unique-stable-value'
```

Then pass the values at execution time:

```sh
inso -w call/workflows/checkout-quickstart.insomnia.yaml \
  run collection "Commerce API — Checkout Quickstart" \
  --env-var "api_key=${ZEBO_API_KEY}" \
  --env-var "base_url=${ZEBO_API_BASE_URL}" \
  --env-var "order_number=${ZEBO_ORDER_NUMBER}" \
  --env-var "idempotency_key=${ZEBO_IDEMPOTENCY_KEY}" \
  --bail
```

Choose a new order number and idempotency key together for each new checkout. Keep both exported values unchanged when retrying the same checkout after a timeout.

Do not use `--printOptions`, shell tracing, or plaintext result output while passing credentials this way. For shared CI, prefer an [external vault integration](https://developer.konghq.com/insomnia/external-vault/) so the collection never receives a persisted credential.

## Hosted checkout workflow

The Checkout and Orders collection is ordered as a workflow:

1. **Create an order** sends `POST /orders/create` with `finalize: true`, inline customer data, and an inline product. It does not set `execute_payment`, so merely sending the request does not charge the customer.
2. Its after-response script stores `order_id` and the hosted `checkout_url`.
3. Open `checkout_url` in a browser and let the customer complete payment, or use **Lookup an order** to poll the order state.
4. Use **Pay for an order**, **Request confirmation**, and **Confirm a payment** only when implementing a custom payment flow. These operations can initiate a real payment attempt.

Change `order_number` and `idempotency_key` together for each new order. Leave both unchanged when retrying after a timeout.

For the shortest verification path, import and run `workflows/checkout-quickstart.insomnia.yaml`. It contains only **Create hosted checkout** followed by **Look up created order**. It never requests or confirms payment.

## Variables

The base environment separates three kinds of values:

- Connection values: `base_url`, `api_key`, and `idempotency_key`.
- Safe example inputs: customer contact fields, checkout return URLs, currency, account-number examples, and `upload_file_path`.
- Chained runtime values: IDs such as `customer_id`, `order_id`, and `file_id`, plus bearer capability URLs such as `checkout_url`, `file_link_url`, and `upload_url`.

Treat API keys, OTPs, confirmation tokens, and capability URLs as secrets. Do not paste them into the base environment or commit an exported environment containing them.

`future_timestamp` is populated by a pre-request script with a value seven days in the future. File requests read `upload_file_path` from the active environment; set it to a file that exists on your machine before sending a multipart request.

## Tests and safety

Folders include after-response tests for successful HTTP status codes. Create requests also capture returned IDs, and OTP verification checks `verification_attempt.result.verdict` rather than treating HTTP 200 as proof that the code matched. Insomnia documents request scripts and assertions in its [scripts guide](https://developer.konghq.com/insomnia/scripts/).

Do not indiscriminately run every collection against a live account. Some collections contain operations that send messages, schedule payouts, change settings, cancel resources, or delete files. Run the specific request or narrowly scoped workflow you intend to exercise.

## Maintenance

Every file conforms to Insomnia's v5 format with schema revision `5.1`. Insomnia publishes the format and its JSON Schema in the [import and export reference](https://developer.konghq.com/insomnia/import-export/).

`commerce.yml` and Call are one reviewed contract. A contract change must update both the OpenAPI operation and its matching primary Call request. From the repository root, run:

```sh
npm ci
npm test
```

The parity test requires exactly one primary Call request for every OpenAPI operation, rejects undocumented Call requests and duplicate mappings, and validates each Call request example against its OpenAPI request schema. It also checks `openapi.lock.json`, which records the reviewed digest of both artifact sets. A one-sided change cannot refresh that lock.

After updating and reviewing both sides, refresh the paired digest and rerun the test:

```sh
npm run contract:update
npm test
```

Run `./scripts/validate.sh` from this directory to validate every public artifact against the pinned v5.1 schema. The script downloads the schema into a temporary directory and does not modify the collections.
