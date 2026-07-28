#!/usr/bin/env node
/**
 * End-to-end packaging verification.
 *
 * Unit tests import `src/`, so they prove nothing about what a consumer
 * actually receives. This script packs the real tarball, installs it into
 * throwaway ESM and CommonJS consumer packages, and then compiles and RUNS code
 * against it — which is the only way to catch the class of defect this exists
 * for:
 *
 *   - the package resolving to CommonJS for an ESM consumer,
 *   - a default export that type-checks clean and throws at runtime,
 *   - declaration maps pointing at sources that were never shipped,
 *   - `instanceof` failing across the ESM/CJS copy boundary.
 *
 * Every check compiles under BOTH moduleResolution "bundler" and "nodenext",
 * because the original defect was visible under one and invisible under the
 * other.
 *
 * Exit code 0 = every check passed.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

let failures = 0;
let checks = 0;

function check(name, fn) {
  checks++;
  try {
    const detail = fn();
    console.log(`  ok    ${name}${detail ? `  — ${detail}` : ''}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(
      String(err && err.message)
        .split('\n')
        .map((l) => `          ${l}`)
        .join('\n')
    );
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Runs a command, returning {status, stdout, stderr} instead of throwing. */
function run(cmd, args, opts) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status === undefined ? 1 : err.status,
      stdout: err.stdout || '',
      stderr: err.stderr || ''
    };
  }
}

function node(file, cwd) {
  const r = run(process.execPath, [file], { cwd });
  if (r.status !== 0) {
    throw new Error(`node ${path.basename(file)} exited ${r.status}\n${r.stdout}${r.stderr}`);
  }
  return r.stdout.trim();
}

/** The `module` setting each `moduleResolution` is legal with. */
const MODULE_FOR = {
  bundler: 'esnext',
  nodenext: 'nodenext',
  node10: 'commonjs'
};

/** Type-checks `file` in `cwd` under the given moduleResolution. */
function typecheck(cwd, file, moduleResolution, label) {
  const cfg = path.join(cwd, `tsconfig.${label}.json`);
  fs.writeFileSync(
    cfg,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: MODULE_FOR[moduleResolution],
          moduleResolution,
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
          types: []
        },
        files: [file]
      },
      null,
      2
    )
  );
  return run(process.execPath, [TSC, '-p', cfg], { cwd });
}

// ---------------------------------------------------------------------------
// Set up: pack the real tarball, install into two scratch consumers.
// ---------------------------------------------------------------------------

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'async-queue-packaging-'));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

console.log(`\nverify-packaging: ${PKG.name}@${PKG.version}`);
console.log(`  workspace: ${WORK}\n`);

let tarball;
try {
  const packed = run('npm', ['pack', '--silent', '--pack-destination', WORK], { cwd: ROOT });
  assert(packed.status === 0, `npm pack failed:\n${packed.stderr}`);
  tarball = path.join(WORK, packed.stdout.trim().split('\n').pop().trim());
  assert(fs.existsSync(tarball), `npm pack reported a tarball that does not exist: ${tarball}`);
} catch (err) {
  console.error(String(err.message));
  process.exit(1);
}

/** Creates a consumer package of the given module type with the tarball installed. */
function makeConsumer(name, type) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', type, private: true }, null, 2)
  );
  const install = run('npm', ['install', '--silent', '--no-audit', '--no-fund', tarball], {
    cwd: dir
  });
  assert(install.status === 0, `npm install failed in ${name}:\n${install.stderr}`);
  return dir;
}

const ESM = makeConsumer('esm-consumer', 'module');
const CJS = makeConsumer('cjs-consumer', 'commonjs');
const INSTALLED = path.join(ESM, 'node_modules', PKG.name);

// ---------------------------------------------------------------------------
// P1 — the package resolves as ESM for an ESM consumer.
// ---------------------------------------------------------------------------

console.log('P1  ESM-first packaging');

check('package.json declares an exports map with "import" and "require"', () => {
  const m = JSON.parse(fs.readFileSync(path.join(INSTALLED, 'package.json'), 'utf8'));
  assert(m.exports, 'no "exports" field');
  assert(m.exports['.'].import, 'no "import" condition');
  assert(m.exports['.'].require, 'no "require" condition');
  assert(m.type, 'no "type" field');
  assert(m.module, 'no "module" field');
  assert(m.sideEffects === false, '"sideEffects" is not false');
  // "types" must come first inside each condition or TypeScript ignores it.
  assert(
    Object.keys(m.exports['.'].import)[0] === 'types',
    '"types" is not the first key of the "import" condition'
  );
  assert(
    Object.keys(m.exports['.'].require)[0] === 'types',
    '"types" is not the first key of the "require" condition'
  );
  return `type=${m.type}, sideEffects=false`;
});

check('the ESM build is real ESM, not a transpiled CommonJS file', () => {
  const src = fs.readFileSync(path.join(INSTALLED, 'dist', 'esm', 'index.js'), 'utf8');
  assert(!src.includes('"use strict"'), 'ESM build contains a "use strict" prologue');
  assert(!src.includes('exports.'), 'ESM build assigns to `exports`');
  assert(!src.includes('__esModule'), 'ESM build sets __esModule');
  assert(/^export class AsyncQueue/m.test(src), 'no top-level `export class AsyncQueue`');
  assert(/^export default AsyncQueue;/m.test(src), 'no top-level `export default AsyncQueue`');
  const marker = JSON.parse(
    fs.readFileSync(path.join(INSTALLED, 'dist', 'esm', 'package.json'), 'utf8')
  );
  assert(marker.type === 'module', 'dist/esm is not marked {"type":"module"}');
  return 'dist/esm marked {"type":"module"}';
});

check('ESM named import resolves to the ESM build and constructs', () => {
  fs.writeFileSync(
    path.join(ESM, 'named.mjs'),
    `import { AsyncQueue, QueueClosedError } from '${PKG.name}';\n` +
      `const q = new AsyncQueue(2);\n` +
      `await q.enqueue('a');\n` +
      `const got = await q.dequeue();\n` +
      `if (got !== 'a') throw new Error('round-trip failed: ' + got);\n` +
      `if (typeof QueueClosedError !== 'function') throw new Error('QueueClosedError missing');\n` +
      `console.log('ok ' + q.constructor.name);\n`
  );
  const out = node(path.join(ESM, 'named.mjs'), ESM);
  assert(out === 'ok AsyncQueue', `unexpected output: ${out}`);
  return 'enqueue/dequeue round-trip works';
});

check('CommonJS require() still works and is unbroken by the exports map', () => {
  fs.writeFileSync(
    path.join(CJS, 'named.cjs'),
    `const { AsyncQueue, QueueClosedError } = require('${PKG.name}');\n` +
      `const q = new AsyncQueue(2);\n` +
      `q.enqueue('a').then(async () => {\n` +
      `  const got = await q.dequeue();\n` +
      `  if (got !== 'a') throw new Error('round-trip failed');\n` +
      `  if (typeof QueueClosedError !== 'function') throw new Error('QueueClosedError missing');\n` +
      `  console.log('ok ' + q.constructor.name);\n` +
      `});\n`
  );
  const out = node(path.join(CJS, 'named.cjs'), CJS);
  assert(out === 'ok AsyncQueue', `unexpected output: ${out}`);
  return 'enqueue/dequeue round-trip works';
});

check('an ESM consumer and a CJS consumer load different files', () => {
  fs.writeFileSync(
    path.join(ESM, 'which.mjs'),
    `import { createRequire } from 'node:module';\n` +
      `const require = createRequire(import.meta.url);\n` +
      `const esm = await import('${PKG.name}');\n` +
      `const cjs = require('${PKG.name}');\n` +
      `console.log(JSON.stringify({\n` +
      `  esmIsNamespace: esm[Symbol.toStringTag] === 'Module',\n` +
      `  distinct: esm.AsyncQueue !== cjs.AsyncQueue\n` +
      `}));\n`
  );
  const out = JSON.parse(node(path.join(ESM, 'which.mjs'), ESM));
  assert(out.esmIsNamespace, 'import did not yield a real ES module namespace');
  assert(out.distinct, 'import and require resolved to the same object (exports map not applied)');
  return 'import -> dist/esm, require -> dist/cjs';
});

// ---------------------------------------------------------------------------
// P2 — the default export is a real constructor, under both resolutions.
// ---------------------------------------------------------------------------

console.log('\nP2  default export');

check('`new Def()` runs in ESM (was: TypeError: Def is not a constructor)', () => {
  fs.writeFileSync(
    path.join(ESM, 'default.mjs'),
    `import Def from '${PKG.name}';\n` +
      `const q = new Def();\n` +
      `console.log(typeof Def + ' ' + q.constructor.name);\n`
  );
  const out = node(path.join(ESM, 'default.mjs'), ESM);
  assert(out === 'function AsyncQueue', `default export is not the class: ${out}`);
  return 'typeof default === "function"';
});

check('`new Def()` runs in CommonJS via esModuleInterop', () => {
  fs.writeFileSync(
    path.join(CJS, 'default.cjs'),
    `const mod = require('${PKG.name}');\n` +
      `const Def = mod.__esModule ? mod.default : mod;\n` +
      `const q = new Def();\n` +
      `console.log(typeof Def + ' ' + q.constructor.name);\n`
  );
  const out = node(path.join(CJS, 'default.cjs'), CJS);
  assert(out === 'function AsyncQueue', `default export is not the class: ${out}`);
  return 'typeof default === "function"';
});

for (const [dir, kind, resolutions] of [
  // "bundler" is where the defect was invisible; "nodenext" is where tsc caught
  // it as TS2351; "node10" is the legacy setting a lot of consumers are still on
  // and the only one that reads the root "types"/"main" fields rather than the
  // exports map.
  [ESM, 'ESM consumer', ['bundler', 'nodenext']],
  [CJS, 'CJS consumer', ['nodenext', 'node10']]
]) {
  for (const mr of resolutions) {
    check(`default import type-checks in a ${kind} under moduleResolution "${mr}"`, () => {
      fs.writeFileSync(
        path.join(dir, `default.${mr}.ts`),
        `import Def from '${PKG.name}';\n` +
          `import { AsyncQueue } from '${PKG.name}';\n` +
          `const a: AsyncQueue<number> = new Def<number>();\n` +
          `const b: AsyncQueue<number> = new AsyncQueue<number>();\n` +
          `void a; void b;\n`
      );
      const r = typecheck(dir, `default.${mr}.ts`, mr, mr);
      assert(
        r.status === 0,
        `tsc exited ${r.status}\n${r.stdout}${r.stderr}`
      );
      return 'tsc exit 0';
    });
  }
}

check('narrowing still works: `err instanceof QueueClosedError` gives err.item', () => {
  fs.writeFileSync(
    path.join(ESM, 'narrow.ts'),
    `import { AsyncQueue, QueueClosedError } from '${PKG.name}';\n` +
      `export async function f(q: AsyncQueue<number>) {\n` +
      `  try { await q.enqueue(1); }\n` +
      `  catch (err) { if (err instanceof QueueClosedError) { const n: unknown = err.item; return n; } }\n` +
      `  return undefined;\n` +
      `}\n`
  );
  const r = typecheck(ESM, 'narrow.ts', 'bundler', 'narrow');
  assert(r.status === 0, `tsc exited ${r.status}\n${r.stdout}${r.stderr}`);
  return 'tsc exit 0';
});

// ---------------------------------------------------------------------------
// Dual-package hazard — the cost of shipping two builds, measured.
// ---------------------------------------------------------------------------

console.log('\nDual-package hazard');

check('QueueClosedError from the CJS copy is instanceof the ESM copy', () => {
  fs.writeFileSync(
    path.join(ESM, 'hazard.mjs'),
    `import { createRequire } from 'node:module';\n` +
      `const require = createRequire(import.meta.url);\n` +
      `const esm = await import('${PKG.name}');\n` +
      `const cjs = require('${PKG.name}');\n` +
      `if (esm.QueueClosedError === cjs.QueueClosedError) throw new Error('not actually two copies');\n` +
      `const fromCjs = new cjs.QueueClosedError('payload');\n` +
      `const fromEsm = new esm.QueueClosedError('payload');\n` +
      `console.log(JSON.stringify({\n` +
      `  cjsErrIsEsmClass: fromCjs instanceof esm.QueueClosedError,\n` +
      `  esmErrIsCjsClass: fromEsm instanceof cjs.QueueClosedError,\n` +
      `  itemSurvives: fromCjs.item === 'payload',\n` +
      `  plainErrorRejected: (new Error('x')) instanceof esm.QueueClosedError,\n` +
      `  stillAnError: fromCjs instanceof Error\n` +
      `}));\n`
  );
  const out = JSON.parse(node(path.join(ESM, 'hazard.mjs'), ESM));
  assert(out.cjsErrIsEsmClass, 'a CJS-copy error is NOT instanceof the ESM-copy class');
  assert(out.esmErrIsCjsClass, 'an ESM-copy error is NOT instanceof the CJS-copy class');
  assert(out.itemSurvives, 'err.item did not survive');
  assert(!out.plainErrorRejected, 'a plain Error was accepted as a QueueClosedError');
  assert(out.stillAnError, 'QueueClosedError is no longer instanceof Error');
  return 'both directions, and a plain Error is still rejected';
});

// ---------------------------------------------------------------------------
// P3 — declaration maps resolve to shipped sources.
// ---------------------------------------------------------------------------

console.log('\nP3  declaration maps');

check('every .d.ts.map source is shipped inside the package', () => {
  const maps = [];
  for (const half of ['cjs', 'esm']) {
    const mapFile = path.join(INSTALLED, 'dist', half, 'index.d.ts.map');
    assert(fs.existsSync(mapFile), `dist/${half}/index.d.ts.map is missing`);
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const src of map.sources) {
      const resolved = path.resolve(path.dirname(mapFile), map.sourceRoot || '', src);
      assert(
        fs.existsSync(resolved),
        `dist/${half}/index.d.ts.map points at ${src}, which is not in the tarball`
      );
      maps.push(path.relative(INSTALLED, resolved));
    }
  }
  return maps.join(', ');
});

check('the shipped source is the source dist/ was built from', () => {
  const shipped = fs.readFileSync(path.join(INSTALLED, 'src', 'index.ts'), 'utf8');
  const local = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf8');
  assert(shipped === local, 'shipped src/index.ts differs from the repository source');
  return `${shipped.split('\n').length} lines`;
});

// ---------------------------------------------------------------------------

fs.rmSync(WORK, { recursive: true, force: true });

console.log(
  `\nverify-packaging: ${checks - failures}/${checks} checks passed` +
    (failures ? ` — ${failures} FAILED\n` : '\n')
);
process.exit(failures ? 1 : 0);
