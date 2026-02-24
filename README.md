# Digital Notice Board

## Supabase Setup

1. Open Supabase SQL Editor and run `digital-notice-board/server/supabase/schema.sql`.
2. Add these variables in the root `.env`:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `JWT_SECRET`
   - `JWT_EXPIRES_IN` (optional, default `7d`)
3. Run automatic setup (Supabase check + optional legacy migration):
   - `cd digital-notice-board/server`
   - `npm run setup:supabase`
4. Start the backend:
   - `npm run dev`

The backend is now Supabase-only (no file DB or MongoDB fallback).
If `check:supabase` reports missing required tables, run `server/supabase/schema.sql` again in Supabase SQL Editor.
`setup:supabase` only runs legacy migration when `server/database.json` exists.
You can manually run `npm run migrate:supabase` if you want to import old `database.json` data.
If only `live_state` is missing, setup/startup continue with an in-memory fallback for live status.
For internet hosting readiness checks, use:
- `GET /api/health` (uptime + database health)
- `GET /api/test` (basic API smoke test)
- `cd digital-notice-board/server && npm run check:smoke` (automated login/options/API flow)
- From project root: `npm run check:all` (frontend + backend + smoke flow)

## Hosting

### Local production host

1. Build frontend:
   - `cd digital-notice-board/client`
   - `npm run build`
2. Start backend (serves API + built frontend):
   - `cd ../server`
   - `npm start`
3. Open `http://localhost:5001`

### Permanent Local Run (No More localhost:5173 Refused)

Use the built-in process manager from `digital-notice-board/`:

1. Start stable local host (single URL, production mode):
   - `npm run serve:up`
2. Open:
   - `http://localhost:5001/admin`
   - `http://localhost:5173/admin` (auto-redirects to `5001` in stable mode)
3. Check status anytime:
   - `npm run local:status`
4. Stop:
   - `npm run serve:down`

If you specifically want dev mode on `5173`:

1. Start both backend + frontend:
   - `npm run dev:up`
2. Open:
   - `http://localhost:5173/admin`
3. Stop both:
   - `npm run dev:down`

### Start Automatically On Windows Login (No CMD Needed)

From project root `digital-notice-board`:

1. Install auto-start in hidden mode (recommended stable mode on `5001`):
   - `npm run autostart:install`
2. Check if installed:
   - `npm run autostart:status`
3. Open:
   - `http://localhost:5001/admin`
   - `http://localhost:5173/admin` (auto-redirects to `5001`)
4. Remove auto-start:
   - `npm run autostart:remove`

If you want dev-mode startup (`5173`) instead:
- `npm run autostart:install:dev`

### Render deploy (single service)

1. Push repo to GitHub.
2. In Render, create a Blueprint deploy from this repo (`render.yaml`).
   - If configuring manually instead of Blueprint:
   - Environment: `Docker`
   - Dockerfile Path: `./Dockerfile`
   - Base Directory: leave empty
3. Set env vars in Render:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `JWT_SECRET`
   - `CLIENT_ORIGIN` (your Render app URL, optional but recommended)
   - Do not set `PORT` manually on Render.

If frontend and backend are hosted on different domains, set frontend env:
- `VITE_API_BASE_URL=https://your-backend-domain.com`

### Vercel + Supabase deploy

#### Option A: Single Vercel project from repo root (quick 404 fix)

This repo now includes root `vercel.json` + `api/[[...path]].js`, so deploying the top-level repository works without `404: NOT_FOUND`.

1. Prepare Supabase:
   - Run `digital-notice-board/server/supabase/schema.sql` in Supabase SQL Editor.
2. Create one Vercel project from this repo (root directory left empty).
3. Set env vars:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `JWT_SECRET`
   - `JWT_EXPIRES_IN` (optional, default `7d`)
   - `SUPABASE_STORAGE_BUCKET` (optional, default `notice-board-uploads`)
   - `CLIENT_ORIGIN=https://your-project.vercel.app` (optional, recommended)
   - `VITE_ENABLE_SOCKET=false` (recommended on Vercel serverless)
   - `VITE_API_BASE_URL` (optional; leave unset to use same-domain `/api`)
4. After deploy, verify:
   - `https://your-project.vercel.app/api/health`
   - `https://your-project.vercel.app/admin`

#### Option B: Two Vercel projects from the same repo (split frontend/backend)

Deploy as two Vercel projects from the same repo:
- Backend project root: `digital-notice-board/server`
- Frontend project root: `digital-notice-board/client`

1. Prepare Supabase:
   - Run `digital-notice-board/server/supabase/schema.sql` in Supabase SQL Editor.
2. Deploy backend (Vercel project #1):
   - Root Directory: `digital-notice-board/server`
   - Install Command: `npm install`
   - Build Command: `npm run build`
   - Output Directory: leave empty
   - Vercel uses `digital-notice-board/server/api/[[...path]].js` as the API entrypoint.
   - Set env vars:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `JWT_SECRET`
   - `JWT_EXPIRES_IN` (optional, default `7d`)
   - `SUPABASE_STORAGE_BUCKET` (optional, default `notice-board-uploads`)
   - `CLIENT_ORIGIN=https://your-frontend-domain.vercel.app`
   - After deploy, verify:
   - `https://your-backend-domain.vercel.app/api/health`
3. Deploy frontend (Vercel project #2):
   - Root Directory: `digital-notice-board/client`
   - Install Command: `npm install`
   - Build Command: `npm run build`
   - Output Directory: `dist`
   - Set env vars:
   - `VITE_API_BASE_URL=https://your-backend-domain.vercel.app`
   - `VITE_ENABLE_SOCKET=false` (recommended on Vercel backend; polling fallback is enabled)
4. Redeploy frontend after setting env vars.
5. If backend `CLIENT_ORIGIN` changes, redeploy backend.

Note for Vercel backend uploads:
- API upload requests are capped for serverless runtime; this backend enforces a 4MB request file limit on Vercel.

If you see `404: NOT_FOUND` right after Vercel deploy, confirm you either:
- deploy repo root (uses root `vercel.json`), or
- set project Root Directory to `digital-notice-board/client` for frontend-only deployment.
# Digital_NoticeBoard
