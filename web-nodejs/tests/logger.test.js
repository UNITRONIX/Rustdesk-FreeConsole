'use strict';

describe('logger', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test('production defaults to warn — info is suppressed', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.LOG_LEVEL;
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const logger = require('../lib/logger');
        expect(logger.level).toBe('warn');
        logger.info('hidden info');
        logger.warn('visible warn');

        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
        logSpy.mockRestore();
        warnSpy.mockRestore();
    });

    test('child logger redacts quoted usernames in info messages', () => {
        process.env.NODE_ENV = 'development';
        process.env.LOG_LEVEL = 'info';
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        const logger = require('../lib/logger').child('AUTH');
        logger.info("Login failed: user 'administrator' not found");

        expect(logSpy).toHaveBeenCalled();
        const line = logSpy.mock.calls[0].join(' ');
        expect(line).toContain('a***r');
        expect(line).not.toContain('administrator');
        logSpy.mockRestore();
    });
});
