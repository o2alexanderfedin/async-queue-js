#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Ensure reports directory exists
const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

// Function to collect system information
function getSystemInfo() {
  const cpuInfo = os.cpus()[0];
  const totalMem = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(1);
  const platform = os.platform();
  const arch = os.arch();
  const nodeVersion = process.version;
  const cpuCores = os.cpus().length;

  // Try to get more detailed CPU info
  let cpuModel = cpuInfo ? cpuInfo.model : 'Unknown';
  let cpuSpeed = cpuInfo ? (cpuInfo.speed / 1000).toFixed(2) : 'Unknown';

  // Get additional info based on platform
  let additionalInfo = {};
  try {
    if (platform === 'linux') {
      // On Linux (GitHub Actions), try to get more details
      try {
        const cpuinfo = execSync('cat /proc/cpuinfo | grep "model name" | head -1', { encoding: 'utf8' });
        const modelMatch = cpuinfo.match(/model name\s*:\s*(.+)/);
        if (modelMatch) cpuModel = modelMatch[1].trim();
      } catch {}

      try {
        const meminfo = execSync('cat /proc/meminfo | grep MemTotal', { encoding: 'utf8' });
        const memMatch = meminfo.match(/MemTotal:\s+(\d+)/);
        if (memMatch) {
          additionalInfo.totalMemKB = parseInt(memMatch[1]);
        }
      } catch {}

      // Try to get virtualization info
      try {
        const virt = execSync('systemd-detect-virt 2>/dev/null || echo "bare-metal"', { encoding: 'utf8' }).trim();
        additionalInfo.virtualization = virt;
      } catch {}
    } else if (platform === 'darwin') {
      // On macOS, try to get more details
      try {
        const sysctl = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim();
        if (sysctl) cpuModel = sysctl;
      } catch {}
    } else if (platform === 'win32') {
      // On Windows, try to get more details
      try {
        const wmicCpu = execSync('wmic cpu get name /value', { encoding: 'utf8' });
        const cpuMatch = wmicCpu.match(/Name=(.+)/);
        if (cpuMatch) cpuModel = cpuMatch[1].trim();
      } catch {}
    }
  } catch (e) {
    // Silently ignore errors from system info collection
  }

  // Check if running in CI environment
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  const runnerName = process.env.RUNNER_NAME || 'Local Machine';
  const runnerOS = process.env.RUNNER_OS || platform;

  return {
    platform: platform.charAt(0).toUpperCase() + platform.slice(1),
    arch,
    nodeVersion,
    cpuModel,
    cpuCores,
    cpuSpeed,
    totalMem,
    hostname: isCI ? runnerName : os.hostname(),
    osRelease: os.release(),
    isCI,
    runnerOS: isCI ? runnerOS : null,
    ...additionalInfo
  };
}

// Function to generate HTML report
function generateBenchmarkHTML(results) {
  const systemInfo = getSystemInfo();
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AsyncQueue Benchmark Report</title>
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

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            margin: 0;
            padding: 0;
            line-height: 1.6;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 2rem;
        }

        h1 {
            color: var(--accent);
            border-bottom: 2px solid var(--bg-tertiary);
            padding-bottom: 0.5rem;
            display: flex;
            align-items: center;
            gap: 1rem;
        }

        .timestamp {
            font-size: 0.9rem;
            color: var(--text-secondary);
            margin-bottom: 2rem;
        }

        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }

        .metric-card {
            background: var(--bg-secondary);
            border: 1px solid var(--bg-tertiary);
            border-radius: 8px;
            padding: 1.5rem;
        }

        .metric-value {
            font-size: 2rem;
            font-weight: bold;
            color: var(--success);
            margin: 0.5rem 0;
        }

        .metric-label {
            color: var(--text-secondary);
            font-size: 0.9rem;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            background: var(--bg-secondary);
            border-radius: 8px;
            overflow: hidden;
        }

        th {
            background: var(--bg-tertiary);
            padding: 1rem;
            text-align: left;
            color: var(--accent);
        }

        td {
            padding: 1rem;
            border-top: 1px solid var(--bg-tertiary);
        }

        tr:hover {
            background: var(--bg-tertiary);
        }

        .performance-bar {
            height: 20px;
            background: linear-gradient(90deg, var(--success) var(--width), transparent var(--width));
            border-radius: 4px;
            position: relative;
        }

        .badge {
            display: inline-block;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.85rem;
            font-weight: bold;
        }

        .badge-success {
            background: var(--success);
            color: var(--bg-primary);
        }

        .badge-warning {
            background: var(--warning);
            color: var(--bg-primary);
        }

        .chart-container {
            background: var(--bg-secondary);
            border: 1px solid var(--bg-tertiary);
            border-radius: 8px;
            padding: 1.5rem;
            margin-top: 2rem;
        }

        .chart-bar {
            display: flex;
            align-items: center;
            margin: 0.5rem 0;
        }

        .chart-label {
            width: 150px;
            color: var(--text-secondary);
        }

        .chart-value {
            flex: 1;
            height: 30px;
            background: var(--bg-tertiary);
            border-radius: 4px;
            position: relative;
            overflow: hidden;
        }

        .chart-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--accent), var(--success));
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: flex-end;
            padding-right: 0.5rem;
            color: var(--bg-primary);
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>
            📊 AsyncQueue Performance Benchmark
        </h1>
        <div class="timestamp">Generated: ${new Date().toLocaleString()}</div>

        <div class="metrics-grid">
            <div class="metric-card">
                <div class="metric-label">Enqueue Performance</div>
                <div class="metric-value">${results.enqueue?.toLocaleString() || 'N/A'}</div>
                <div class="metric-label">operations/second</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Dequeue Performance</div>
                <div class="metric-value">${results.dequeue?.toLocaleString() || 'N/A'}</div>
                <div class="metric-label">operations/second</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Cycle Performance</div>
                <div class="metric-value">${results.cycle?.toLocaleString() || 'N/A'}</div>
                <div class="metric-label">operations/second</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Concurrent Performance</div>
                <div class="metric-value">${results.concurrent?.toLocaleString() || 'N/A'}</div>
                <div class="metric-label">operations/second</div>
            </div>
        </div>

        <h2>Detailed Results</h2>
        <table>
            <thead>
                <tr>
                    <th>Test Scenario</th>
                    <th>Operations/sec</th>
                    <th>p50</th>
                    <th>p90</th>
                    <th>p99</th>
                    <th>Relative Margin</th>
                    <th>Samples</th>
                    <th>Measurement</th>
                </tr>
            </thead>
            <tbody>
                ${generateTableRows(results.details || [])}
            </tbody>
        </table>

        <div class="chart-container">
            <h3>Performance Comparison</h3>
            ${generateChart(results.details || [])}
        </div>

        <div class="chart-container">
            <h3>Test Configuration</h3>
            <table>
                <tr>
                    <td>Queue Size</td>
                    <td>${results.config?.queueSize || 100}</td>
                </tr>
                <tr>
                    <td>Test Duration</td>
                    <td>${results.config?.duration || 'Auto'}</td>
                </tr>
                <tr>
                    <td>Warm-up Cycles</td>
                    <td>${results.config?.warmup || '10'}</td>
                </tr>
            </table>
        </div>

        <div class="chart-container">
            <h3>Machine Specifications</h3>
            <table>
                <tr>
                    <td>Environment</td>
                    <td>${systemInfo.isCI ? '🤖 CI/CD Runner' : '💻 Local Machine'}</td>
                </tr>
                <tr>
                    <td>CPU Model</td>
                    <td>${systemInfo.cpuModel}</td>
                </tr>
                <tr>
                    <td>CPU Cores</td>
                    <td>${systemInfo.cpuCores} cores @ ${systemInfo.cpuSpeed} GHz</td>
                </tr>
                <tr>
                    <td>Total Memory</td>
                    <td>${systemInfo.totalMem} GB</td>
                </tr>
                <tr>
                    <td>Platform</td>
                    <td>${systemInfo.platform} (${systemInfo.arch})</td>
                </tr>
                <tr>
                    <td>OS Release</td>
                    <td>${systemInfo.osRelease}</td>
                </tr>
                <tr>
                    <td>Node Version</td>
                    <td>${systemInfo.nodeVersion}</td>
                </tr>
                ${systemInfo.virtualization ? `
                <tr>
                    <td>Virtualization</td>
                    <td>${systemInfo.virtualization}</td>
                </tr>` : ''}
                <tr>
                    <td>Host</td>
                    <td>${systemInfo.hostname}</td>
                </tr>
            </table>
        </div>
    </div>
</body>
</html>`;
}

function generateTableRows(details) {
  return details.map(test => {
    const performance = getPerformanceLevel(test);
    return `
        <tr>
            <td>${test.name}</td>
            <td><strong>${test.ops?.toLocaleString() || 'N/A'}</strong></td>
            <td>${ns(test.p50)}</td>
            <td>${ns(test.p90)}</td>
            <td>${ns(test.p99)}</td>
            <td>±${test.rme != null ? test.rme.toFixed(2) : 'N/A'}%</td>
            <td>${test.samples || 'N/A'}</td>
            <td><span class="badge badge-${performance}">${performance.toUpperCase()}</span></td>
        </tr>
    `;
  }).join('');
}

function ns(value) {
  return value == null ? 'N/A' : `${value.toFixed(1)}ns`;
}

function generateChart(details) {
  if (!details || details.length === 0) return '<p>No data available</p>';

  const maxOps = Math.max(...details.map(d => d.ops || 0));

  return details.map(test => {
    const percentage = ((test.ops || 0) / maxOps) * 100;
    return `
        <div class="chart-bar">
            <div class="chart-label">${test.name}</div>
            <div class="chart-value">
                <div class="chart-fill" style="width: ${percentage}%">
                    ${test.ops?.toLocaleString() || '0'} ops/s
                </div>
            </div>
        </div>
    `;
  }).join('');
}

/**
 * The badge reports measurement QUALITY, not magnitude.
 *
 * It used to be `ops > 100000 ? 'success' : ...`, which rated a number good
 * purely for being large — including the hard-coded sample numbers this script
 * used to publish when no benchmark had run. A result is only worth anything if
 * its relative margin of error is small enough to call it a measurement.
 */
function getPerformanceLevel(test) {
  const rme = test.rme;
  if (rme == null) return 'warning';
  if (rme <= 5) return 'success';
  if (rme <= 15) return 'warning';
  return 'danger';
}

// Export for use in benchmarks
module.exports = { generateBenchmarkHTML };

/**
 * Loads the results of a real benchmark run.
 *
 * This function replaces a hard-coded `sampleResults` block that this script
 * published as if it were a measurement — including `cycle: 647920`, the source
 * of the README's "647K ops/sec" badge. Nothing had ever measured that number,
 * and it sat four lines below a headline claiming 10,000,000 ops/sec. There is
 * now no fallback on purpose: with no run to report, the correct output is an
 * error, not a plausible-looking page.
 */
function loadResults() {
  const file = path.join(__dirname, '..', 'benchmark-results', 'throughput.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      `No benchmark results at ${file}. Run "npm run benchmark" first — this script ` +
        'reports measurements and has no sample data to fall back on.'
    );
  }

  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byName = name => report.cases.find(c => c.name === name);
  const opsOf = name => (byName(name) || {}).opsPerSecond;

  return {
    enqueue: opsOf('enqueue only (filling buffer)'),
    dequeue: opsOf('dequeue only (pre-filled)'),
    cycle: opsOf('cycle, buffered (no suspend)'),
    concurrent: opsOf('concurrent 1P/1C, buffer=1024'),
    details: report.cases.map(c => ({
      name: c.name,
      ops: c.opsPerSecond,
      p50: c.p50,
      p90: c.p90,
      p99: c.p99,
      rme: c.rme,
      samples: c.samples
    })),
    machine: report.machine,
    generatedAt: report.generatedAt,
    config: {
      queueSize: 'per case, see table',
      duration: `${report.cases[0] ? report.cases[0].samples : 0} samples per case`,
      warmup: '20 untimed iterations per case'
    }
  };
}

if (require.main === module) {
  const html = generateBenchmarkHTML(loadResults());
  fs.writeFileSync(path.join(reportsDir, 'benchmark-report.html'), html);
  console.log('✅ Benchmark report generated from benchmark-results/throughput.json');
}