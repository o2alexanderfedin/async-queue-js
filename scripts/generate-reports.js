#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('📊 Generating comprehensive reports...\n');

// Ensure reports directory exists
/**
 * Live project statistics, read from the artifacts the CI run just produced.
 *
 * This replaces four hard-coded values on the reports landing page — "91.3%",
 * "57 tests", "647K ops/sec", "v1.1.0" — none of which were regenerated when
 * the numbers behind them changed, and one of which ("647K") had never been
 * measured at all. Anything missing renders as "N/A" rather than as a stale
 * number that looks current.
 */
function readStats() {
  const root = path.join(__dirname, '..');
  const read = file => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch {
      return null;
    }
  };

  const pkg = read('package.json');
  const coverage = read('coverage/coverage-summary.json');
  const tests = read('reports/test-results.json');
  const bench = read('benchmark-results/throughput.json');

  const headline =
    bench && bench.cases
      ? bench.cases.find(c => c.name === 'cycle, buffered (no suspend)')
      : null;

  const formatOps = ops => {
    if (ops == null) return 'N/A';
    if (ops >= 1e6) return `${(ops / 1e6).toFixed(1)}M`;
    if (ops >= 1e3) return `${Math.round(ops / 1e3)}K`;
    return String(ops);
  };

  return {
    version: pkg ? `v${pkg.version}` : 'N/A',
    statements: coverage ? `${coverage.total.statements.pct}%` : 'N/A',
    branches: coverage ? `${coverage.total.branches.pct}%` : 'N/A',
    functions: coverage ? `${coverage.total.functions.pct}%` : 'N/A',
    testCount: tests ? String(tests.numTotalTests) : 'N/A',
    testsPassing: tests ? (tests.numFailedTests === 0 ? '100% Passing' : `${tests.numFailedTests} failing`) : 'N/A',
    ops: formatOps(headline ? headline.opsPerSecond : null),
    opsDetail: headline ? `p50 ${headline.p50.toFixed(1)}ns, ±${headline.rme.toFixed(2)}%` : 'not measured',
    machine: bench && bench.machine ? `${bench.machine.cpu}, Node ${bench.machine.node}` : 'unknown machine'
  };
}

const stats = readStats();

const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

// 1. Generate test report with coverage
console.log('🧪 Running tests with coverage...');
try {
  execSync('npm run test:coverage', { stdio: 'inherit' });
  console.log('✅ Test and coverage reports generated');
} catch (error) {
  console.error('⚠️ Some tests failed, but reports were generated');
}

// 2. Copy coverage report to reports directory
const coverageSource = path.join(__dirname, '..', 'coverage');
const coverageDest = path.join(reportsDir, 'coverage');
if (fs.existsSync(coverageSource)) {
  execSync(`cp -r ${coverageSource} ${coverageDest}`);
  console.log('✅ Coverage report copied to reports/coverage');
}

// 3. Generate index.html for GitHub Pages
const indexHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AsyncQueue - Test & Performance Reports</title>
    <style>
        :root {
            --bg-primary: #0d1117;
            --bg-secondary: #161b22;
            --bg-tertiary: #1c2128;
            --text-primary: #c9d1d9;
            --text-secondary: #8b949e;
            --accent: #58a6ff;
            --success: #3fb950;
            --warning: #d29922;
            --danger: #f85149;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            line-height: 1.6;
        }

        .hero {
            background: linear-gradient(135deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
            padding: 3rem 0;
            border-bottom: 1px solid var(--accent);
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 0 2rem;
        }

        h1 {
            font-size: 2.5rem;
            color: var(--accent);
            margin-bottom: 0.5rem;
        }

        .subtitle {
            color: var(--text-secondary);
            font-size: 1.2rem;
        }

        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem;
            margin: 2rem 0;
        }

        .stat-card {
            background: var(--bg-secondary);
            border: 1px solid var(--bg-tertiary);
            border-radius: 8px;
            padding: 1.5rem;
            text-align: center;
            transition: transform 0.2s, border-color 0.2s;
        }

        .stat-card:hover {
            transform: translateY(-2px);
            border-color: var(--accent);
        }

        .stat-value {
            font-size: 2rem;
            font-weight: bold;
            color: var(--success);
            margin-bottom: 0.5rem;
        }

        .stat-label {
            color: var(--text-secondary);
        }

        .reports-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 2rem;
            margin: 3rem 0;
        }

        .report-card {
            background: var(--bg-secondary);
            border: 1px solid var(--bg-tertiary);
            border-radius: 12px;
            padding: 2rem;
            transition: transform 0.3s, box-shadow 0.3s;
        }

        .report-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
        }

        .report-icon {
            font-size: 3rem;
            margin-bottom: 1rem;
        }

        .report-title {
            font-size: 1.5rem;
            color: var(--accent);
            margin-bottom: 1rem;
        }

        .report-description {
            color: var(--text-secondary);
            margin-bottom: 1.5rem;
        }

        .report-link {
            display: inline-block;
            padding: 0.75rem 1.5rem;
            background: var(--accent);
            color: var(--bg-primary);
            text-decoration: none;
            border-radius: 6px;
            font-weight: bold;
            transition: background 0.3s;
        }

        .report-link:hover {
            background: var(--success);
        }

        .footer {
            margin-top: 4rem;
            padding: 2rem 0;
            border-top: 1px solid var(--bg-tertiary);
            text-align: center;
            color: var(--text-secondary);
        }

        .footer a {
            color: var(--accent);
            text-decoration: none;
        }

        .footer a:hover {
            text-decoration: underline;
        }

        .badge {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 20px;
            font-size: 0.85rem;
            margin: 0 0.25rem;
        }

        .badge-success {
            background: var(--success);
            color: var(--bg-primary);
        }

        .badge-info {
            background: var(--accent);
            color: var(--bg-primary);
        }
    </style>
</head>
<body>
    <div class="hero">
        <div class="container">
            <h1>📊 AsyncQueue Reports</h1>
            <p class="subtitle">TypeScript Async Producer-Consumer Queue with Backpressure Control</p>

            <div class="stats">
                <div class="stat-card">
                    <div class="stat-value">${stats.statements}</div>
                    <div class="stat-label">Statement Coverage</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${stats.testCount}</div>
                    <div class="stat-label">Tests Passing</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${stats.ops}</div>
                    <div class="stat-label">Ops/Second (${stats.opsDetail})</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${stats.version}</div>
                    <div class="stat-label">Latest Version</div>
                </div>
            </div>
        </div>
    </div>

    <div class="container">
        <div class="reports-grid">
            <div class="report-card">
                <div class="report-icon">🧪</div>
                <h2 class="report-title">Test Report</h2>
                <p class="report-description">
                    Detailed test results with execution time, console output, and failure details.
                    <br><br>
                    <span class="badge badge-success">${stats.testCount} Tests</span>
                    <span class="badge badge-info">${stats.testsPassing}</span>
                </p>
                <a href="test-report.html" class="report-link">View Test Report →</a>
            </div>

            <div class="report-card">
                <div class="report-icon">📈</div>
                <h2 class="report-title">Coverage Report</h2>
                <p class="report-description">
                    Interactive code coverage visualization with line-by-line analysis.
                    <br><br>
                    <span class="badge badge-success">${stats.branches} Branches</span>
                    <span class="badge badge-info">${stats.functions} Functions</span>
                </p>
                <a href="coverage/index.html" class="report-link">View Coverage →</a>
            </div>

            <div class="report-card">
                <div class="report-icon">⚡</div>
                <h2 class="report-title">Benchmark Report</h2>
                <p class="report-description">
                    Throughput and per-operation latency (p50/p90/p99), measured on
                    ${stats.machine}.
                    <br><br>
                    <span class="badge badge-success">${stats.ops} ops/sec</span>
                    <span class="badge badge-info">O(1) Operations</span>
                </p>
                <a href="benchmark-report.html" class="report-link">View Benchmarks →</a>
            </div>

            <div class="report-card">
                <div class="report-icon">📦</div>
                <h2 class="report-title">NPM Package</h2>
                <p class="report-description">
                    Published package on NPM registry with full TypeScript support.
                    <br><br>
                    <span class="badge badge-success">Latest: ${stats.version}</span>
                    <span class="badge badge-info">MIT License</span>
                </p>
                <a href="https://www.npmjs.com/package/@alexanderfedin/async-queue" target="_blank" class="report-link">View on NPM →</a>
            </div>

            <div class="report-card">
                <div class="report-icon">💻</div>
                <h2 class="report-title">Source Code</h2>
                <p class="report-description">
                    Full source code, documentation, and examples on GitHub.
                    <br><br>
                    <span class="badge badge-success">Open Source</span>
                    <span class="badge badge-info">TypeScript</span>
                </p>
                <a href="https://github.com/o2alexanderfedin/async-queue-js" target="_blank" class="report-link">View on GitHub →</a>
            </div>

            <div class="report-card">
                <div class="report-icon">📖</div>
                <h2 class="report-title">Documentation</h2>
                <p class="report-description">
                    Comprehensive API documentation with examples and performance notes.
                    <br><br>
                    <span class="badge badge-success">Full API Docs</span>
                    <span class="badge badge-info">Examples</span>
                </p>
                <a href="https://github.com/o2alexanderfedin/async-queue-js#readme" target="_blank" class="report-link">View Docs →</a>
            </div>
        </div>

        <div class="footer">
            <p>
                Generated on ${new Date().toLocaleString()} |
                <a href="https://github.com/o2alexanderfedin/async-queue-js">GitHub</a> |
                <a href="https://www.npmjs.com/package/@alexanderfedin/async-queue">NPM</a> |
                Created by AI Hive® at <a href="https://o2.services">O2.services</a>
            </p>
        </div>
    </div>
</body>
</html>`;

fs.writeFileSync(path.join(reportsDir, 'index.html'), indexHTML);
console.log('✅ Index page generated: reports/index.html');

console.log('\n🎉 All reports generated successfully!');
console.log('📁 Reports available in: reports/');
console.log('\nTo view locally: open reports/index.html');