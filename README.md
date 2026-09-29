# GUtech Accommodation Permits

University accommodation permit portal with a student access gate and protected admin dashboard.

## Run locally

```powershell
npm install
Copy-Item .env.example .env
node create-admin.js "YOUR_ADMIN_PASSWORD"
# Put the generated hash in .env as ADMIN_PASSWORD_HASH
npm start
```

Open `http://localhost:3000`.

## Deploy correctly

GitHub Pages can only serve the static interface. It cannot run the Node.js API, sessions, login, or data storage. To make every feature work, deploy this repository as a Node web service on Render using the included `render.yaml`.

1. Push the repository to GitHub.
2. In Render, choose **New Blueprint** and select this repository.
3. Set `ADMIN_PASSWORD_HASH`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as Environment Variables.
4. Deploy and open the Render URL. Use that URL for students.

The Render service serves both the page and `/api/*` routes from the same origin.

## Storage: Supabase (keep this — it is what protects your data)

The permit data lives in **Supabase**, not on the Render service. `render.yaml` therefore declares **no persistent disk**, on purpose.

A Render disk is tied to one service instance and is not something you can move to a new service, so keeping the data there risks losing everything when a service is replaced. With Supabase, the data is outside the deployment entirely: deploy, rollback, rebuild or replace the service as often as you like and the permits and students are untouched.

Required environment variables:

```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

The server uses local JSON files only when both of these are absent, which is the local-development path. At boot it logs `Storage mode: supabase` or `Storage mode: files`, so you can confirm which one is live. If Supabase is unreachable the server logs a warning instead of quietly serving an empty roster.

Create the table once with `supabase/schema.sql`.

### Back up before you deploy

```powershell
npm run backup                 # writes backups/supabase-backup.json
npm run restore backups/supabase-backup.json
```

`restore` writes a `.pre-restore.json` safety copy of the current state before it overwrites anything.

## Do not commit

`.env`, `data/`, backups and the service-role key must stay out of the repository. `backups/` is git-ignored for that reason.

GitHub repository: https://github.com/accommodation-permit/GUtech-Accommodation-Permits
