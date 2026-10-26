# gym-membership-service

Baseline Express scaffold for a fitness/gym membership domain: bare-minimum setup with a single `Member` resource and full CRUD, proving the project structure before feature tickets build on top.

## Domain model

- **Member** — firstName, lastName, email (unique, required), phone (optional), membershipPlan (`BASIC` / `STANDARD` / `PREMIUM`, defaults to `BASIC`), status (`ACTIVE` / `INACTIVE` / `SUSPENDED`, defaults to `ACTIVE`), joinedAt (defaults to today)

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
- `GET /api/members/:id` — get one (`404` if missing)
- `PUT /api/members/:id` — partial update
- `DELETE /api/members/:id`
- `POST /api/members/:id/merge` — `{ "duplicateMemberId" }` — merges the duplicate account into the account in `:id` (the kept account). The duplicate row is deleted and its payments are moved to the kept account by `POST /api/payments/merge` on gym-payments-service. The kept account's name, plan and status are left unchanged. Returns `200` with the kept member. `400` when `duplicateMemberId` equals `:id` (self-merge), `404` when either account does not exist, and `502` when the payments move fails — in which case nothing is applied and both accounts stay as they were

### Payments service

`POST /api/members/:id/merge` calls gym-payments-service over HTTP. Its base URL comes from
`PAYMENTS_SERVICE_URL` (default `http://localhost:3001`, see `.env.example`).

## Planned tickets (not yet implemented)

1. **Class scheduling** — classes (name, trainer, time slot, capacity) and member bookings against them
2. **Trainer assignment** — round-robin or scoped trainer assignment to classes/members
3. **Attendance check-in** — check-in endpoint tied to a member + class/session, with history
4. **Membership billing & renewal** — plan pricing, renewal due dates, reminder/notification hook
5. **Search & filtering** — filter members by plan/status, filter classes by trainer/time
