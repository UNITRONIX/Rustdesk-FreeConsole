'use strict';

/**
 * Strip dangerous substrings until a full pass produces no change.
 * @param {string} input
 * @param {Array<(s: string) => string>} replacers
 * @returns {string}
 */
function stripUntilStable(input, replacers) {
    let result = String(input ?? '');
    let prev;
    do {
        prev = result;
        for (const replacer of replacers) {
            result = replacer(result);
        }
    } while (result !== prev);
    return result;
}

/**
 * Remove opening/closing HTML/SVG tags for a given tag name (case-insensitive).
 * @param {string} input
 * @param {string} tagName
 * @returns {string}
 */
function stripTagName(input, tagName) {
    const name = String(tagName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const open = new RegExp(`<\\s*${name}\\b[^>]*>`, 'gi');
    const close = new RegExp(`<\\s*/\\s*${name}\\b[^>]*>`, 'gi');
    const selfClose = new RegExp(`<\\s*${name}\\b[^>]*/\\s*>`, 'gi');
    let result = input;
    let prev;
    do {
        prev = result;
        result = result.replace(open, '').replace(close, '').replace(selfClose, '');
    } while (result !== prev);
    return result;
}

module.exports = {
    stripUntilStable,
    stripTagName,
};
