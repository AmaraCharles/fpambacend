module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 15000,
  // ESM-only dependency of @turf/turf — see tests/stubs/concaveman.js
  moduleNameMapper: { '^concaveman$': '<rootDir>/tests/stubs/concaveman.js' },
};
