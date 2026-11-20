# Turboencabulator

An interactive, comic-shaded 3D model of the Turboencabulator, built from General Electric handbook sheet HBK-8359 (Dec. 31, 1962), with a write-up on how it was made.

**Live:** https://liambeckman.com/turbo-encabulator/

You can spin and explode the machine, pick a wave shape (sinusoidal, cosinusoidal, tangential or pipusoidal) and pluck the 47 grouting brushes, which behave like a vibrating string.

## Running locally

There's no build step. Serve the folder with any static server, for example:

```sh
python3 -m http.server 4410
```

Then open http://localhost:4410. three.js and anime.js load from jsDelivr through the import map in `index.html`.

## Files

| File         | What it does                                                                        |
| ------------ | ----------------------------------------------------------------------------------- |
| `index.html` | The page: the 3D machine at the top, then the write-up                              |
| `main.js`    | Scene, comic shaders (halftone fill and ink outline), parts, anime.js timelines, UI |
| `string.js`  | The brush-string simulation, shared by the machine and Figure 3                     |
| `figures.js` | The write-up's interactive figures: the halftone sphere and the flattened string    |
| `style.css`  | Styles for the machine and the write-up                                             |
| `images/`    | The two pages of the handbook sheet                                                 |

## Credits

- Original text by John Hellins Quick, 1944. Handbook sheet by General Electric, HBK-8359, 1962.
- Visual style after Raj Shekhar's [Voyager](https://rshekhar.com/voyager/).
- Built with [three.js](https://threejs.org) and [anime.js](https://animejs.com).
