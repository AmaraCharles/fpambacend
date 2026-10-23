module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 60000,
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  testPathIgnorePatterns: ['/node_modules/', '/tests/helpers/', '/tests/stubs/'],
  // ESM-only dependency of @turf/turf — see tests/stubs/concaveman.js
  moduleNameMapper: { '^concaveman$': '<rootDir>/tests/stubs/concaveman.js' },
};
