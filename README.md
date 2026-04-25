# Farmers Fightback

A static one-page site for the Farmers Fightback coalition, designed to be deployed via GitHub Pages.

## Structure

- `index.html` — page markup, all sections in one document
- `styles.css` — design system, layout, responsive rules
- `script.js` — sticky-header, mobile menu, scroll reveals, animated counters, form validation
- `.nojekyll` — disables Jekyll processing on GitHub Pages

## Deploy via GitHub Pages (Deploy from a branch)

1. Push this branch to GitHub (already done if you got here from Claude Code).
2. In the repo on GitHub, go to **Settings → Pages**.
3. Under **Build and deployment**, set:
   - **Source**: *Deploy from a branch*
   - **Branch**: `claude/deploy-github-pages-UAofF` (or whichever branch you merge this into — typically `main`)
   - **Folder**: `/ (root)`
4. Click **Save**. The first deploy takes about a minute. The site URL will appear at the top of the Pages settings page.

> Tip: GitHub Pages is happiest serving from `main` or `gh-pages`. If you'd like, merge this branch into `main` and point Pages there.

## Local preview

Any static server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Customizing

- Replace stat numbers in `index.html` (`data-count` attributes inside `.stats`).
- Swap testimonial copy and story cards directly in `index.html`.
- Tweak the palette via the CSS custom properties at the top of `styles.css`.
- The signup form is client-side only — wire it up to a service like Mailchimp, ConvertKit, or Formspree by changing the submit handler in `script.js`.
