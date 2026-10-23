# gym-membership-service

Baseline Express scaffold for a fitness/gym membership domain: bare-minimum setup with a single `Member` resource and full CRUD, proving the project structure before feature tickets build on top.

## Domain model

- **Member** — firstName, lastName, email (unique, required), phone (optional), membershipPlan (`BASIC` / `STANDARD` / `PREMIUM`, defaults to `BASIC`), status (`ACTIVE` / `INACTIVE` / `SUSPENDED`, defaults to `ACTIVE`), joinedAt (defaults to today), renewalDate (`DATEONLY`, nullable — `null` until the member's first renewal, written only by the renewal flow)

## Stack

- Express 4
- Sequelize + SQLite for local dev (swap the dialect in `src/config/database.js` for Postgres/MySQL in other environments)
- helmet, cors, morgan for baseline hardening/logging

## Project structure

```
src/
  config/      # DB connection, plan pricing
  models/      # Sequelize models
  services/    # business logic, DB access, payments-service client
  controllers/ # request/response handling
  routes/      # route definitions
  middleware/  # error handling, 404
  app.js       # express app wiring
  server.js    # entrypoint, DB sync, listen
```

## Run

```
cp .env.example .env
npm install
npm run dev
```

Listens on `http://localhost:3000` (configurable via `PORT`). SQLite file is created at `data/dev.sqlite` on first run.

### Existing databases and the `renewalDate` column

The server only calls `sequelize.sync()` (it does **not** run migrations and does **not** use
`sync({ alter: true })`, which would rewrite tables and risk local data). That means an existing
`data/dev.sqlite` created before `renewalDate` was added will not gain the column. Recreate the
local database to pick it up:

```
rm -f data/dev.sqlite
npm run dev
```

A fresh database gets the column automatically on first start.

## Endpoints

- `GET /api/health` — liveness check
- `POST /api/members` — `{ "firstName", "lastName", "email", "phone", "membershipPlan" }` — firstName, lastName, email required; email must be unique
- `GET /api/members` — list all
- `GET /api/members/:id` — get one (`404` if missing)
- `PUT /api/members/:id` — partial update
- `DELETE /api/members/:id`
- `POST /api/members/:id/renew` — no request body (the member id is in the path). Charges the plan's price through the payments service and, on success, records the charge there and sets the member's `renewalDate` to today + 30 days. The member's `status` is left untouched. Responds `200` with `{ member, payment }` (the updated member and the charge recorded by the payments service), `402` when the charge is declined (payment `status` of `FAILED` — the renewal is not applied and `renewalDate` stays as it was), `404` for an unknown member (no charge is attempted), `503` when the payments service cannot be reached (the renewal is not applied), and `502` when the payments service answers with an error.
- `GET /api/members/:id/payments` — the member's payment history, fetched from the payments service and returned exactly as that service returns it (nothing is stored in this service). Empty array when the member has no charges; `503` if the payments service cannot be reached.

### Renewal prices

| Plan | Renewal fee |
| --- | --- |
| BASIC | 19.99 |
| STANDARD | 29.99 |
| PREMIUM | 49.99 |

The price table lives in `src/config/planPricing.js`.

### Payments service configuration

The membership service calls a separate payments service for renewals and payment history.
Set its base URL with `PAYMENTS_SERVICE_URL` (see `.env.example`); it defaults to
`http://localhost:3001`, the payments service's own local port. The HTTP calls use Node's global
`fetch`, so Node 18+ is required.

## Planned tickets (not yet implemented)

1. **Class scheduling** — classes (name, trainer, time slot, capacity) and member bookings against them
2. **Trainer assignment** — round-robin or scoped trainer assignment to classes/members
3. **Attendance check-in** — check-in endpoint tied to a member + class/session, with history
4. **Renewal reminders & notifications** — reminder/notification hook for upcoming renewal dates (the renewal charge and `renewalDate` update itself are implemented; refunds, retries/idempotency, auto-renewal scheduling, proration and price changes over time are not)
5. **Search & filtering** — filter members by plan/status, filter classes by trainer/time
