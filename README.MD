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

## Main Behavior
- Stock is stored in `Procurement.remaining_kg`.
- Cash sale (`POST /api/sales`) deducts stock atomically.
- Credit sale (`POST /api/credits`) also deducts stock atomically.
- Credit payment (`PATCH /api/credits/:id/pay`) updates status (`pending` -> `partial` -> `paid`).
- Branch isolation is enforced from JWT branch for non-director users.

## Dashboard Auto Refresh
- Sales agent dashboard polling: every **60s**
- Manager dashboard polling: every **60s**
- Director dashboard polling: every **30s**

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
  models/
  routes/
  store/branchesStore.js
```

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
```

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
- Do not commit real secrets.
- If a secret was ever committed before, rotate it.

## Current Status
- Backend and MongoDB integration validated.
- Role permissions and branch isolation validated.
- Core sale/procurement/credit flows validated.
