export default {
  test: {
    include: ["qualification/*.test.ts"],
    maxWorkers: 1,
    testTimeout: 60000,
  },
};
