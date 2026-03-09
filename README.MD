# Karibu Groceries LTD

Branch-based wholesale management system for:
- stock/procurement
- cash sales
- credit sales and payments
- director administration (users + branches)

## Stack
- Node.js + Express
- MongoDB + Mongoose
- JWT auth (`jsonwebtoken`)
- Password hashing (`bcryptjs`)
- Security middleware (`helmet`, `cors`)
- Frontend: HTML/CSS/Vanilla JS + Toastify

## Roles
- `director`: all branches, user and branch management
- `manager`: own branch, procurement/restock, sales/credit actions
- `sales_agent`: own branch, sales/credit actions
- `agent`: legacy alias accepted by sales/credit/procurement-read APIs (treated as sales-agent scope)

## Main Behavior
- Stock is stored in `Procurement.remaining_kg`.
- Procurement create (`POST /api/procurement`) rejects duplicate produce names in a branch and guides user to restock existing produce.
- Procurement create also blocks conflicting produce types for the same produce name (e.g., `G-Nuts` as both `Legume` and `Nuts`).
- Cash sale (`POST /api/sales`) deducts stock atomically.
- Cash sale blocks transactions when the same produce name has inconsistent types in stock.
- Credit sale (`POST /api/credits`) also deducts stock atomically.
- Credit sale validates `produce_type` against stocked produce type and blocks mismatches.
- Credit payment (`PATCH /api/credits/:id/pay`) updates status (`pending` -> `partial` -> `paid`).
- Branch isolation is enforced from JWT branch for non-director users.

## Dashboard Auto Refresh
- Sales agent dashboard polling: every **30s**
- Manager dashboard polling: every **30s**
- Director dashboard polling: every **30s**
- While filling Manager/Sales forms, polling keeps notifications updated without resetting selected produce fields.

## Professional Screenshots
Place production-ready screenshots in `docs/screenshots/` using the exact filenames below.

### 1) Login
![Login Screen](docs/screenshots/01-login.png)
Clean login page with brand identity and validation states.

### 2) Sales Agent Dashboard
![Sales Agent Dashboard](docs/screenshots/02-sales-dashboard.png)
Live stock view, cash sale form, credit sale form, and recent branch transactions.

### 3) Manager Dashboard
![Manager Dashboard](docs/screenshots/03-manager-dashboard.png)
Procurement, restock workflows, branch performance stats, and alerts.

### 4) Director Dashboard
![Director Dashboard](docs/screenshots/04-director-dashboard.png)
Cross-branch oversight, users/branches administration, and executive KPIs.

### 5) Procurement Flow (Duplicate Protection)
![Procurement Duplicate Protection](docs/screenshots/05-procurement-duplicate-rule.png)
Attempt to add existing produce and clear API/UI rejection with restock guidance.

### 6) Sales/Credit Consistency Validation
![Sales Credit Validation](docs/screenshots/06-sales-credit-type-validation.png)
Validation message when produce name/type is inconsistent across stock records.

### 7) Credit Payment Tracking
![Credit Payment Tracking](docs/screenshots/07-credit-payments.png)
Partial/full payment updates and automatic status transition (`pending` -> `partial` -> `paid`).

### 8) Mobile View
![Mobile Dashboard](docs/screenshots/08-mobile-view.png)
Responsive sidebar and dashboard usability on small screens.

## Project Structure
```txt
public/
  index.html
  css/style.css
  js/
    common.js
    auth.js
    sales.js
    manager.js
    director.js
  pages/
    sales/dashboard.html
    manager/dashboard.html
    director/dashboard.html
src/
  server.js
  middleware/auth.js
  scripts/
    fix-produce-conflicts.js
  models/
  routes/
  store/branchesStore.js
```

## NPM Scripts
- `npm run dev`: start API with nodemon
- `npm start`: start API in normal mode
- `npm run cleanup:produce:audit`: detect produce name/type conflicts and normalization candidates (dry-run)
- `npm run cleanup:produce:apply`: apply produce normalization/conflict fixes

## Setup
1. Install dependencies:
```bash
npm install
```

2. Create `.env`:
```env
MONGO_URI=mongodb://localhost:27017/karibugroceries
JWT_SECRET=replace_with_strong_secret
PORT=5000
NODE_ENV=development
CORS_ORIGIN=http://localhost:5000
RATE_LIMIT_MAX=300
LOGIN_RATE_LIMIT_MAX=10
INIT_DIRECTOR_NAME=
INIT_DIRECTOR_EMAIL=
INIT_DIRECTOR_PASSWORD=
```
`INIT_DIRECTOR_*` values are optional. If provided and no director exists, the server auto-creates the first director on startup.

3. Run API server:
```bash
npm run dev
```

Server starts at:
`http://localhost:5000`

## API Routes

### Auth
- `POST /api/auth/login`

### Procurement
- `POST /api/procurement`
- `GET /api/procurement/available?branch=...`
- `GET /api/procurement/all?branch=...`
- `GET /api/procurement/history/:id`
- `PATCH /api/procurement/:id/restock`

### Sales
- `POST /api/sales`
- `GET /api/sales/branch?branch=...`

### Credits
- `POST /api/credits`
- `GET /api/credits/branch?branch=...`
- `PATCH /api/credits/:id/pay`

### Director Admin
- `GET /api/users`
- `POST /api/users`
- `PATCH /api/users/:id`
- `DELETE /api/users/:id`
- `GET /api/branches`
- `POST /api/branches`
- `PATCH /api/branches/:id`
- `DELETE /api/branches/:id`

## Security Notes
- `.env` is ignored by Git.
- `mongo-backup/` and `*.bson` are ignored by Git.
- Do not commit real secrets.
- If a secret was ever committed before, rotate it.
- In production, set `CORS_ORIGIN` explicitly (comma-separated origins if needed).
- `JWT_SECRET` must be at least 32 characters.

## Render Deployment (API + Frontend)
This repo includes both:
- API service (`type: web`)
- Frontend static site (`type: static`)

After creating services from `render.yaml`:
1. Set API env var `CORS_ORIGIN` to include your frontend Render URL.
   Example: `https://karibu-groceries-ltd-frontend.onrender.com`
2. In `public/js/config.js`, set:
```js
window.__KGL_API_BASE__ = 'https://karibu-groceries-api.onrender.com';
```
3. Redeploy frontend, then share the frontend URL for dashboard testing.

If frontend and API are served from the same origin, leave `window.__KGL_API_BASE__ = ''`.
