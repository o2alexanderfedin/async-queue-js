module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/benchmark/test'],
  testMatch: ['**/*.test.ts'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!node_modules/**',
    '!test/**',
    '!examples/**'
  ],
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90
    }
  },
  coverageReporters: ['html', 'lcov', 'text', 'json-summary'],
  reporters: [
    'default',
    ['jest-html-reporter', {
      pageTitle: 'AsyncQueue Test Report',
      outputPath: './reports/test-report.html',
      includeFailureMsg: true,
      includeConsoleLog: true,
      theme: 'darkTheme',
      dateFormat: 'yyyy-mm-dd HH:MM:ss'
    }]
  ],
  verbose: true
}