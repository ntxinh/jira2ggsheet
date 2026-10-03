# gh-pages — jira2ggsheet landing site

Static landing page served by GitHub Pages at
https://ntxinh.github.io/jira2ggsheet/

- **Source:** `site/` (Vite + React + TS + Tailwind v4 + Framer Motion + Lucide)
- **Served files:** `index.html` + `assets/` at this branch's root — the built output, committed.

Rebuild after editing source:

```bash
cd site
npm ci
npm run pages   # builds to dist/, copies to branch root, touches .nojekyll
```
