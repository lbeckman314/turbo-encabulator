# Turboencabulator

An interactive, comic-shaded 3D model of the Turboencabulator, built from General Electric handbook sheet HBK-8359 (Dec. 31, 1962), with a write-up on how it was made.

**Live:** https://liambeckman.com/turbo-encabulator/

You can spin and explode the machine, pick a wave shape (sinusoidal, cosinusoidal, tangential or pipusoidal) and pluck the 47 grouting brushes, which behave like a vibrating string.

## Running locally

The page itself needs no build step. Serve the folder with any static server, for example:

```sh
python3 -m http.server 4410
```

Then open http://localhost:4410. three.js and anime.js load from jsDelivr through the import map in `index.html`.

## Editing the write-up

The write-up is written in `post.md` and rendered into `index.html` by `build.mjs`, between the `<!-- post:start -->` and `<!-- post:end -->` markers. Commit the rebuilt `index.html` along with `post.md`: GitHub Pages serves the files as they are, with no build of its own.

```sh
npm install       # once
npm run build     # rebuild index.html from post.md
npm run dev       # rebuild whenever post.md or a partial changes
```

Besides ordinary Markdown (including tables and raw HTML such as `<var>`), `post.md` supports:

- front matter: `title`, `date` (YYYY-MM-DD) and comma-separated `tags`, which become the post header
- `## Heading {#id}` to set a heading's id
- `::: callout Label` … `:::` for a labelled aside
- `@include partials/<file>.html` on its own line to insert an HTML partial, used for the figures, the handbook images and the equation
- `@youtube <id> <caption>`, one per line, for videos; consecutive lines form a grid. Each shows a thumbnail and only loads YouTube's player (from the privacy-enhanced youtube-nocookie.com) when clicked
- `[name](#part:<id>)` to link a phrase to a part of the machine (ids such as `casing`, `fan`, `winding` are the first argument to `part(...)` in `main.js`). Hovering the phrase lights the part up, clicking it scrolls up to show it, and clicking the part on the machine scrolls back to the phrase.

## Files

| File         | What it does                                                                        |
| ------------ | ----------------------------------------------------------------------------------- |
| `index.html` | The page: the 3D machine at the top, then the write-up (generated from `post.md`)   |
| `post.md`    | The write-up, in Markdown                                                           |
| `partials/`  | HTML pieces the write-up includes: the figures, the handbook images, the equation   |
| `build.mjs`  | Renders `post.md` into `index.html`                                                 |
| `main.js`    | Scene, comic shaders (halftone fill and ink outline), parts, anime.js timelines, UI |
| `string.js`  | The brush-string simulation, shared by the machine and Figure 3                     |
| `figures.js` | The write-up's interactive figures: the halftone sphere and the flattened string    |
| `style.css`  | Styles for the machine and the write-up                                             |
| `images/`    | The two pages of the handbook sheet                                                 |

## Credits

- Original text by John Hellins Quick, 1944. Handbook sheet by General Electric, HBK-8359, 1962.
- Visual style after Raj Shekhar's [Voyager](https://rshekhar.com/voyager/).
- Built with [three.js](https://threejs.org) and [anime.js](https://animejs.com).
