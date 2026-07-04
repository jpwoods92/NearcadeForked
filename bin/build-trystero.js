const path = require('path');
const esbuild = require('esbuild');

// app/src/scripts/p2p-signaler.js imports { joinRoom } from a browser-servable
// single-file bundle. @trystero-p2p/torrent's own npm dist imports
// @trystero-p2p/core via a bare specifier a browser <script type="module">
// can't resolve unbundled, so this flattens both into one file. Regenerate
// with `npm run build:trystero` whenever the trystero-p2p dependencies bump.
const entry = path.join(__dirname, '..', 'node_modules', '@trystero-p2p', 'torrent', 'dist', 'index.mjs');
const outfile = path.join(__dirname, '..', 'app', 'src', 'scripts', 'trystero-bundle.js');

esbuild
  .build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile,
    minify: false,
    banner: {
      js: '// GENERATED FILE — do not edit by hand.\n// Regenerate with `npm run build:trystero` (see bin/build-trystero.js).',
    },
  })
  .then(() => console.log(`[build:trystero] Wrote ${path.relative(process.cwd(), outfile)}`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
