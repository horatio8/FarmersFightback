# Farmers Fightback

Homepage for the Farmers Fightback campaign.

Static site (React 18 + Babel via unpkg, no build step), edited through a git-based CMS at `/admin/`.

## Files

- `index.html` — page shell, loads React + Babel + Microsoft Clarity
- `app.jsx` — React app, **renders entirely from `content/site.json`**
- `styles.css` — design tokens and components
- `assets/logo.png`, `assets/uploads/` — campaign logo + media uploaded via the CMS
- `content/site.json` — all editable copy, numbers, links, video URLs
- `admin/index.html`, `admin/config.yml` — Decap CMS UI + content schema
- `.nojekyll` — disables Jekyll on GitHub Pages

## Editing content

Two ways:

**A. CMS (`/admin/`).** After auth setup is done (below), browse to `https://<your-pages-url>/admin/`, log in with GitHub, edit any section in a friendly form UI, click **Publish**. Decap commits the change to this branch and Pages redeploys in ~1 min.

**B. Edit `content/site.json` directly** in the GitHub web editor or locally. Same effect — commit, push, Pages redeploys.

The site fetches `content/site.json` on every page load (`cache: "no-cache"`) so changes show up immediately after deploy.

## CMS auth setup (one time)

Decap CMS needs to log you in as a GitHub user with write access to this repo. Because the site is on GitHub Pages (not Netlify), the auth flow needs a small OAuth proxy you control. Steps:

### 1. Create a GitHub OAuth App

1. https://github.com/settings/developers → **New OAuth App**
2. **Application name**: `Farmers Fightback CMS` (any name)
3. **Homepage URL**: your Pages URL, e.g. `https://horatio8.github.io/FarmersFightback/`
4. **Authorization callback URL**: `https://YOUR-OAUTH-PROXY-DOMAIN/callback` — fill this in after step 2.
5. **Register application** → note the **Client ID** and generate a **Client Secret**.

### 2. Deploy an OAuth proxy (Cloudflare Workers, free)

I recommend [`sterlp/decap-cms-cloudflare-oauth`](https://github.com/sterlp/decap-cms-cloudflare-oauth) — a one-file Cloudflare Worker. ~3 minutes.

1. Sign up at https://workers.cloudflare.com (free tier covers this).
2. **Create a Worker**, paste the script from that repo's README.
3. Add the secrets in the Worker's settings:
   - `OAUTH_CLIENT_ID` = your GitHub OAuth Client ID
   - `OAUTH_CLIENT_SECRET` = your GitHub OAuth Client Secret
4. Deploy. Note the Worker URL (e.g. `https://ff-oauth.your-account.workers.dev`).
5. Go back to your GitHub OAuth App and set **Authorization callback URL** to `<worker-url>/callback`.

Alternative proxies that work the same way: [`vencax/netlify-cms-github-oauth-provider`](https://github.com/vencax/netlify-cms-github-oauth-provider) on Render or Fly.

### 3. Wire the proxy into Decap

Edit `admin/config.yml` and replace the `base_url` value:

```yaml
backend:
  name: github
  repo: horatio8/FarmersFightback
  branch: claude/deploy-github-pages-UAofF
  base_url: https://ff-oauth.your-account.workers.dev   # <— your worker
```

Commit and push. Visit `/admin/` and **Login with GitHub** — you should land in the editor.

### 4. (Optional) Switch the editing branch

The CMS currently writes to `claude/deploy-github-pages-UAofF`. If you merge that into `main` and switch Pages to serve from `main`, also change the `branch:` field above.

## Deploy via GitHub Pages

Settings → Pages → **Deploy from a branch** → pick the same branch as `admin/config.yml`, folder `/ (root)` → Save.

## Local preview

```sh
python3 -m http.server 8000
# http://localhost:8000          — site
# http://localhost:8000/admin/   — CMS (login won't work locally without proxy)
```

## Content schema

`content/site.json` mirrors the homepage section by section. The Decap form in `admin/config.yml` has the same shape — field labels in the CMS match the JSON keys. Add new sections by:

1. Adding a key to `content/site.json` with sensible defaults
2. Reading it from a component in `app.jsx`
3. Adding the matching field group to `admin/config.yml`
