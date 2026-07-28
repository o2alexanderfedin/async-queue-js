#!/usr/bin/env node
/**
 * Proves that every shipped .js / .d.ts / .d.ts.map in dist/ is exactly what tsc
 * produces from src/, with no manual edits and no post-processing.
 *
 * Method: recompile both halves of the build into a throwaway directory using
 * the same tsconfigs, then byte-compare (SHA-256) against the committed dist/.
 * Any difference — a hand-patched export, a stale artifact from an older source
 * revision, a minifier someone slipped into the pipeline — fails the check.
 *
 * The two package.json markers are excluded by construction: they are generated
 * by scripts/write-dist-markers.js, not by tsc, and are verified separately for
 * exact content rather than against a compiler run.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/**
 * The rebuild must land at the same directory depth as dist/, because
 * declarationMap records the path from the output file back to the source
 * ("../../src/index.ts"). Compiling into os.tmpdir() would produce a correct
 * but differently-rooted relative path and every .d.ts.map would compare
 * unequal for a reason that has nothing to do with provenance.
 */
const TMP = path.join(ROOT, '.provenance-check');

/** Files in dist/ that are written by scripts/write-dist-markers.js, not by tsc. */
const EXPECTED_MARKERS = {
  'cjs/package.json': { type: 'commonjs' },
  'esm/package.json': { type: 'module' }
};

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every file under `dir`, as paths relative to `dir`, sorted. */
function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function fail(msg) {
  console.error(`\n  FAIL  ${msg}`);
  process.exitCode = 1;
}

if (!fs.existsSync(path.join(DIST, 'cjs', 'index.js'))) {
  console.error('verify-provenance: dist/ is not built. Run `npm run build` first.');
  process.exit(1);
}

fs.rmSync(TMP, { recursive: true, force: true });
const tmp = TMP;

try {
  console.log('verify-provenance: recompiling src/ into a throwaway directory...');

  for (const [config, sub] of [
    ['tsconfig.build.cjs.json', 'cjs'],
    ['tsconfig.build.esm.json', 'esm']
  ]) {
    execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        path.join(ROOT, config),
        '--outDir',
        path.join(tmp, sub)
      ],
      { cwd: ROOT, stdio: 'inherit' }
    );
  }

  const shipped = walk(DIST).filter((f) => !(f in EXPECTED_MARKERS));
  const rebuilt = walk(tmp);

  console.log(`\n  comparing ${shipped.length} compiler-produced file(s)\n`);

  const onlyShipped = shipped.filter((f) => !rebuilt.includes(f));
  const onlyRebuilt = rebuilt.filter((f) => !shipped.includes(f));

  for (const f of onlyShipped) {
    fail(`dist/${f} is shipped but tsc does not produce it (stray or hand-added file)`);
  }
  for (const f of onlyRebuilt) {
    fail(`tsc produces ${f} but it is missing from dist/ (stale build)`);
  }

  for (const f of shipped.filter((x) => rebuilt.includes(x))) {
    const a = sha256(path.join(DIST, f));
    const b = sha256(path.join(tmp, f));
    if (a === b) {
      console.log(`  ok    dist/${f}  sha256:${a.slice(0, 16)}`);
    } else {
      fail(`dist/${f} differs from a fresh tsc run\n          shipped: ${a}\n          rebuilt: ${b}`);
    }
  }

  // The markers are not compiler output; assert their exact content instead.
  for (const [rel, expected] of Object.entries(EXPECTED_MARKERS)) {
    const file = path.join(DIST, rel);
    if (!fs.existsSync(file)) {
      fail(`dist/${rel} is missing — run scripts/write-dist-markers.js`);
      continue;
    }
    const actual = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`dist/${rel} should be ${JSON.stringify(expected)} but is ${JSON.stringify(actual)}`);
    } else {
      console.log(`  ok    dist/${rel}  (generated marker: ${JSON.stringify(expected)})`);
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error('\nverify-provenance: dist/ is NOT reproducible from src/.\n');
} else {
  console.log('\nverify-provenance: dist/ is byte-identical to a fresh tsc run from src/.\n');
}
