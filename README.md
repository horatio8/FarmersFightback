# Farmers Fightback

Homepage for the Farmers Fightback campaign — a farmer-led coalition from the Wallaloo & Gre Gre district fighting the $11.4B VNI West transmission line.

Built from a design handoff bundle. Static site, no build step.

## Files

- `index.html` — page shell, loads React 18 + Babel from unpkg
- `app.jsx` — the homepage app (hero, impact bar, latest video, summary + map, petition, action cards, quote, donate band, newsletter, footer, video modal)
- `styles.css` — design tokens (navy `#12354B`, red `#C62828`), components, responsive rules
- `assets/logo.png` — campaign logo
- `.nojekyll` — disables Jekyll processing on GitHub Pages

## Deploy via GitHub Pages (Deploy from a branch)

1. In the repo on GitHub: **Settings → Pages**.
2. **Source**: *Deploy from a branch* — **Branch**: `claude/deploy-github-pages-UAofF`, folder `/ (root)` → **Save**.
3. The site URL appears at the top of the Pages settings page after ~1 minute.

> Pages also works from `main` or `gh-pages` if you'd prefer to merge there.

## Local preview

Any static server works. The page loads React + Babel from unpkg, so it will compile JSX in the browser on first load.

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Productionising

For a production deploy, swap the in-browser Babel/JSX setup for a real build (Vite, esbuild) — the CDN approach is fine for a campaign microsite but adds ~200 KB and a JSX-compile step on first load.

Replace the striped `Placeholder` blocks in `app.jsx` with real photos / video as they're produced — each one is labelled with its intended content (e.g. `HERO · PROTEST CONVOY AT PARLIAMENT`).
