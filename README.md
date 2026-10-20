# x44ylan

Personal site at [x44ylan.com](https://x44ylan.com/), built with VitePress.

## Development

Requires Node.js 22 or later.

```sh
npm ci
npm run dev
```

To build and preview:

```sh
npm run build
npm run preview
```

Pushing to `main` deploys to GitHub Pages.

## Scenery themes

The homepage uses `debris`. Every theme also has an unlisted preview route, for example `/train` or `/sharks`:

`debris`, `train`, `sharks`, `fireflies`, `rain`

A hidden index of every theme lives at `/themes`. It isn't linked from the site or listed in the sitemap.

To change the homepage theme, edit the default `theme` in `docs/.vitepress/theme/components/Scenery.vue`.
