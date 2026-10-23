# gym-payments-service

Payment records API for the gym membership platform: records charges and refunds against a
member and exposes that member's payment history. The membership service calls this service to
charge a renewal and proxies its per-member history endpoint, so payment records live here and
nowhere else.

## Domain model

- **Payment** — memberId, amount, type (`CHARGE` / `REFUND`), status (`SUCCESS` / `PENDING` / `FAILED`), reason (optional free text), relatedPaymentId (optional, set on a refund to point at the charge it reverses)

## Stack

- Express 4
- helmet, cors, morgan for baseline hardening/logging

## Run

```
cp .env.example .env
npm install
npm run dev
```

Listens on `http://localhost:3001` (configurable via `PORT`) — the default base URL the
membership service uses for `PAYMENTS_SERVICE_URL`.

## Endpoints

- `POST /api/payments/charge` — `{ "memberId", "amount", "reason", "status" }` — records a charge (`type: 'CHARGE'`) and responds `201` with the payment as it was stored. `memberId` and `amount` are required; `reason` is optional.
  - `status` is **optional**. When omitted it defaults to `SUCCESS`, so a plain charge call records a successful payment.
  - Allowed values are exactly `SUCCESS` and `FAILED`. Whatever is supplied is what gets stored and returned — a charge sent with `status: "FAILED"` is recorded and answered as `FAILED`, it is not rewritten to `SUCCESS`.
  - Any other value (for example `PENDING`, which is not accepted on a charge) is rejected with `400` and no payment row is created.
- Refunds are recorded as payments with `type: 'REFUND'`, carrying a `relatedPaymentId` that must point at an existing charge.
- `GET /api/payments/member/:memberId` — every payment recorded against that member, including both `CHARGE` and `REFUND` entries; an unknown member simply has no payments, so the answer is an empty list.
