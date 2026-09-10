# API changelog

This changelog covers customer-visible changes to the public Inttegro API
contract. The endpoint reference documents the complete current contract.

## 0.1.0-beta6 - 2026-09-10

### Changed

- Published concrete nested schemas for balances, purchase intents, products,
  payment methods, payments, and orders so generated clients can expose named
  domain types instead of generic objects.
- Aligned payment next-action values and their associated data with the public
  payment lifecycle, including authorization and confirmation requests.
- Described the balance snapshot using the currently supported GHS balance
  instead of an arbitrary currency map.
- Removed the `/orders/refund` compatibility path from the published contract.
  Create refunds with `/refunds/create`.

## 0.1.0-beta2 - 2026-09-09

### Added

- Added contract-version metadata to the Postman and Insomnia collections so
  readers can tell which API contract a downloaded collection represents.

## 0.1.0-beta1 - 2026-09-08

### Added

- Published downloadable Postman and Insomnia collections for the API and the
  hosted-checkout quickstart.
- Added the public Checkout payment capability and its payment lifecycle
  objects.
- Added refund cancellation and exposed refunds on returned orders.
- Added typed balance-transaction values and filters.
- Added customer-supplied payment-method data when creating an order.

### Changed

- Required an idempotency key when creating a file link.
- Separated reusable money amounts from catalog prices in the public schema.
- Nested purchase-intent quantity settings under the quantity object.
- Standardized public error documents and Inttegro API host names.
- Removed application identity from purchase-intent responses.
- Removed internal instrument fingerprints from financial-account and
  payment-method responses.
