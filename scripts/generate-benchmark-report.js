#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Ensure reports directory exists
const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

// Function to generate HTML report
function generateBenchmarkHTML(results) {
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
                    <th>Relative Margin</th>
                    <th>Samples</th>
                    <th>Performance</th>
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
                <tr>
                    <td>Platform</td>
                    <td>${process.platform} (${process.arch})</td>
                </tr>
                <tr>
                    <td>Node Version</td>
                    <td>${process.version}</td>
                </tr>
            </table>
        </div>
    </div>
</body>
</html>`;
}

function generateTableRows(details) {
  return details.map(test => {
    const performance = getPerformanceLevel(test.ops);
    return `
        <tr>
            <td>${test.name}</td>
            <td><strong>${test.ops?.toLocaleString() || 'N/A'}</strong></td>
            <td>±${test.rme || 'N/A'}%</td>
            <td>${test.samples || 'N/A'}</td>
            <td><span class="badge badge-${performance}">${performance.toUpperCase()}</span></td>
        </tr>
    `;
  }).join('');
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

function getPerformanceLevel(ops) {
  if (ops > 100000) return 'success';
  if (ops > 10000) return 'warning';
  return 'danger';
}

// Export for use in benchmarks
module.exports = { generateBenchmarkHTML };

// If run directly, generate a sample report
if (require.main === module) {
  const sampleResults = {
    enqueue: 198771,
    dequeue: 53505,
    cycle: 647920,
    concurrent: 125000,
    details: [
      { name: 'Enqueue (empty queue)', ops: 198771, rme: 259.73, samples: 100 },
      { name: 'Dequeue (pre-filled)', ops: 53505, rme: 59.06, samples: 100 },
      { name: 'Enqueue+Dequeue cycle', ops: 647920, rme: 33.88, samples: 100 },
      { name: 'Concurrent operations', ops: 125000, rme: 45.2, samples: 100 }
    ],
    config: {
      queueSize: 100,
      duration: 'Auto',
      warmup: 10
    }
  };

  const html = generateBenchmarkHTML(sampleResults);
  fs.writeFileSync(path.join(reportsDir, 'benchmark-report.html'), html);
  console.log('✅ Sample benchmark report generated: reports/benchmark-report.html');
}