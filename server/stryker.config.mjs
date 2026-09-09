// @ts-check
// Mutation testing config. Runs the `node:test` suite through the tap runner.
//
// Two knobs, both env vars, so one config serves every module:
//   STRYKER_MUTATE      - glob(s) of source to mutate  (comma-separated)
//   STRYKER_TEST_FILES  - glob(s) of test files to run (comma-separated)
// Narrowing the test files to just the ones that exercise a module keeps a
// per-module run to seconds rather than minutes (each DB test file spins up its
// own in-process PostgreSQL).

const mutate = (process.env.STRYKER_MUTATE ?? 'src/**/*.ts').split(',');
const testFiles = (process.env.STRYKER_TEST_FILES ?? 'test/*.test.ts').split(',');

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  reporters: ['html', 'json', 'clear-text', 'progress'],
  testRunner: 'tap',
  tap: {
    testFiles,
    // --test-isolation=none keeps every test file in the same process as
    // Stryker's `-r` coverage hook, so per-file mutant coverage is recorded.
    nodeArgs: ['--import', 'tsx', '--test', '--test-isolation=none', '--test-reporter=tap'],
  },
  coverageAnalysis: process.env.STRYKER_COVERAGE ?? 'perTest',
  checkers: [],
  // TypeScript 7's slim JS API lacks parseConfigFileTextToJson, which Stryker's
  // tsconfig preprocessor calls. Point it at a file that isn't in the sandbox so
  // the preprocessor no-ops; tests run through tsx, which needs no rewrite.
  tsconfigFile: 'tsconfig.stryker-noop.json',
  disableTypeChecks: true,
  concurrency: 6,
  timeoutMS: 60000,
  timeoutFactor: 3,
  mutate: [
    ...mutate,
    '!src/types.ts',
    '!src/index.ts',
    '!src/db/schema.ts',
  ],
  ignorePatterns: ['dist', 'coverage', 'reports', '.stryker-tmp', 'node_modules'],
  thresholds: { high: 100, low: 100, break: 100 },
};
