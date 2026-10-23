# gym-membership-service

Baseline Express scaffold for a fitness/gym membership domain: bare-minimum setup with a single `Member` resource and full CRUD, proving the project structure before feature tickets build on top.

## Domain model

- **Member** — firstName, lastName, email (unique, required), phone (optional), membershipPlan (`BASIC` / `STANDARD` / `PREMIUM`, defaults to `BASIC`), status (`ACTIVE` / `INACTIVE` / `SUSPENDED` / `CANCELLED`, defaults to `ACTIVE`), joinedAt (defaults to today), renewalDate (required, defaults to today; advanced by one month when a renewal charge succeeds), refundStatus (`PENDING` / `COMPLETED` / `FAILED`, null until a cancellation requests a refund; `COMPLETED` is the member-facing word for the payments service's `SUCCESS`), refundNeedsFollowUp (boolean, defaults to `false`; set when a refund could not be confirmed at cancellation time)

> **Existing local databases must be recreated.** The `renewalDate`, `refundStatus` and
> `refundNeedsFollowUp` columns were added to the `members` table, and startup only runs
> `sequelize.sync()` (without `alter`), which does not add columns to a table that already exists.
> Delete a `data/dev.sqlite` created before this change so it is recreated with the new columns.

## Stack

- Express 4
- Sequelize + SQLite for local dev (swap the dialect in `src/config/database.js` for Postgres/MySQL in other environments)
- helmet, cors, morgan for baseline hardening/logging

## Project structure

```
src/
  config/      # DB connection
  models/      # Sequelize models
  services/    # business logic, DB access
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

## Endpoints

- `GET /api/health` — liveness check
- `POST /api/members` — `{ "firstName", "lastName", "email", "phone", "membershipPlan" }` — firstName, lastName, email required; email must be unique
- `GET /api/members` — list all
- `GET /api/members/:id` — get one (`404` if missing). Carries `refundStatus` (`PENDING` / `COMPLETED` / `FAILED`, `null` when no refund was ever requested) and `refundNeedsFollowUp`, so the outcome of a cancellation's refund is readable on request
- `PUT /api/members/:id` — partial update
- `POST /api/members/:id/renew` — empty body; charges the plan's renewal price (BASIC 29.99, STANDARD 49.99, PREMIUM 79.99, from `src/constants/planPricing.js`) against gym-payments-service and, only if that charge succeeds, sets `renewalDate` to one month from today. Returns `200` with the updated member; `402` when the charge did not go through, `503` when the payments service cannot be reached (renewal not applied in either case)
- `POST /api/members/:id/cancel` — empty body; sets `status` to `CANCELLED` and, while the `renewalDate` is still in the future, asks gym-payments-service to refund the unused part of the current paid period (prorated by days remaining, from `src/utils/refundCalculation.js`) against that member's most recent `CHARGE` in their payment history. Nothing is refunded when the renewal date is today or already past, or when the history has no charge. The cancellation goes through even when the refund cannot be confirmed: `refundStatus` becomes `PENDING` and `refundNeedsFollowUp` `true`; a refund the payments service records as `SUCCESS` sets `refundStatus` to `COMPLETED` and clears the flag. Returns `200` with the member plus a `refund` summary (`status`, `amount`, `relatedPaymentId`, `message`); `409` when the membership is already cancelled or that renewal payment has already been refunded (no cancellation in either case), `404` for an unknown member
- `GET /api/members/:id/payments` — that member's payment history (renewal charges and the refunds against them), proxied live from gym-payments-service (nothing is stored in this service). Returns `200` with the same list the payments service returns — including `REFUND` entries with status `PENDING`, `SUCCESS` or `FAILED`, each linked to the charge it reverses by `relatedPaymentId` — `404` if the member is unknown, `503` when the payments service cannot be reached, `502` when it answers with an error. Because the proxy is the live source of truth, a member whose `refundStatus` is `PENDING` has it refreshed from the history: a settled refund reads `SUCCESS` → `refundStatus` `COMPLETED`, `FAILED` → `refundStatus` `FAILED` (both clear `refundNeedsFollowUp`), and a refund still `PENDING` leaves the stored value untouched. Nothing is refreshed when the history cannot be loaded
- `DELETE /api/members/:id`

## Planned tickets (not yet implemented)

1. **Class scheduling** — classes (name, trainer, time slot, capacity) and member bookings against them
2. **Trainer assignment** — round-robin or scoped trainer assignment to classes/members
3. **Attendance check-in** — check-in endpoint tied to a member + class/session, with history
4. **Membership billing & renewal** — plan pricing, renewal due dates, reminder/notification hook
5. **Search & filtering** — filter members by plan/status, filter classes by trainer/time
