const { jestConfig } = require('@salesforce/sfdx-lwc-jest/config');

module.exports = {
    ...jestConfig,
    testEnvironment: 'jsdom',
    // Allow ESM packages under @lwc/* and @salesforce/* to be transformed
    transformIgnorePatterns: [
        '/node_modules/(?!(@lwc|@salesforce/sfdx-lwc-jest)/)',
    ],
    moduleNameMapper: {
        // Apex method mocks
        '^@salesforce/apex/JevReflexController\\.evaluate$':
            '<rootDir>/force-app/test/jest-mocks/apex/JevReflexController/evaluate.js',
        '^@salesforce/apex/JevReflexController\\.generateResolution$':
            '<rootDir>/force-app/test/jest-mocks/apex/JevReflexController/generateResolution.js',
        // Static resource mock
        '^@salesforce/resourceUrl/flashAgentWorker$':
            '<rootDir>/force-app/test/jest-mocks/staticresource/flashAgentWorker.js',
        // LWC component resolution
        '^c/webMcpBridge$':
            '<rootDir>/force-app/main/default/lwc/webMcpBridge/webMcpBridge.js',
        // Spread remaining mappers from preset
        ...jestConfig.moduleNameMapper,
    },
    testMatch: ['**/__tests__/**/*.test.js'],
    collectCoverageFrom: [
        'force-app/main/default/lwc/**/*.js',
        '!force-app/main/default/lwc/**/__tests__/**',
    ],
    coverageThreshold: {
        global: { lines: 80 },
    },
};
