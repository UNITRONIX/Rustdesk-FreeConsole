'use strict';

/**
 * Provider contract used by RealClientBuildService. Providers own only their
 * transport/runtime integration; configuration validation, persistence,
 * retention and UI-facing status normalization stay in BuildService.
 */
class RealClientBuildProvider {
    constructor(id) {
        if (!id) throw new Error('Build provider id is required');
        this.id = id;
    }

    capabilities() {
        throw new Error('capabilities() is not implemented');
    }

    sourceCommitFor() {
        return null;
    }

    async dispatch() {
        throw new Error('dispatch() is not implemented');
    }

    async inspect() {
        throw new Error('inspect() is not implemented');
    }

    async cancel() {
        throw new Error('cancel() is not implemented');
    }
}

module.exports = RealClientBuildProvider;
