module.exports = {
      transform: {
      '^.+\\.jsx?$': 'babel-jest',
    },
    roots: ['<rootDir>'],
    testMatch: ['**/*.spec.js'],
    coveragePathIgnorePatterns: ['<rootDir>/lib/utils.test.js'],
    coverageDirectory: "../../../test/coverage-reports/jest/layers/main/analysis/audio/",
    coverageReporters: [['lcov', { projectRoot: '../../../' }], 'text'],
    setupFiles: ['<rootDir>/setEnvVars.js']
  };