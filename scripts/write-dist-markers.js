#!/usr/bin/env node
/**
 * Writes the two package.json marker files that tell Node (and TypeScript's
 * node16/nodenext resolver) the module format of each half of the dual build.
 *
 * Why these exist
 * ---------------
 * tsc cannot rename its output extension, so both halves of the build emit
 * `index.js`. Node decides whether a `.js` file is ESM or CJS from the nearest
 * package.json "type" field. Without these markers, `dist/esm/index.js` would
 * inherit the root package's "type": "commonjs" and Node would try to parse
 * `export class ...` as CommonJS, producing a SyntaxError at import time.
 *
 * Both markers are written explicitly — including the one that merely restates
 * the inherited value — so that the format of each directory is pinned locally
 * and cannot be changed by editing the root package.json.
 *
 * This does NOT edit tsc's output. index.js / index.d.ts / index.d.ts.map are
 * byte-for-byte what the compiler produced; `npm run verify:provenance` proves
 * it. These are new sibling files, and they are the only non-tsc files in dist/.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');

/** @type {Array<[string, {type: string}]>} */
const MARKERS = [
  ['cjs', { type: 'commonjs' }],
  ['esm', { type: 'module' }]
];

let wrote = 0;

for (const [dir, contents] of MARKERS) {
  const target = path.join(DIST, dir);

  if (!fs.existsSync(path.join(target, 'index.js'))) {
    console.error(
      `write-dist-markers: ${path.relative(process.cwd(), target)}/index.js is missing — ` +
        'run the compile steps first (npm run build).'
    );
    process.exit(1);
  }

  fs.writeFileSync(
    path.join(target, 'package.json'),
    JSON.stringify(contents, null, 2) + '\n'
  );
  wrote++;
}

console.log(`write-dist-markers: wrote ${wrote} module-format markers into dist/`);
