#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const pkgPath = path.resolve(process.cwd(), 'package.json');
let pkg;
try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    pkg = JSON.parse(raw);
} catch (error) {
    console.error('[cw.api.core.queue.local] Unable to read package.json:', error.message);
    process.exit(1);
}

function readUrl(value) {
    if (!value) {
        return '';
    }
    if (typeof value === 'string') {
        return value.trim();
    }
    if (typeof value === 'object' && typeof value.url === 'string') {
        return value.url.trim();
    }
    return '';
}

const repositoryUrl = readUrl(pkg.repository);
const bugsUrl = readUrl(pkg.bugs);
const homepageUrl = typeof pkg.homepage === 'string' ? pkg.homepage.trim() : '';

const missing = [];
if (!repositoryUrl) missing.push('repository.url');
if (!bugsUrl) missing.push('bugs.url');
if (!homepageUrl) missing.push('homepage');

if (missing.length > 0) {
    const message = `[cw.api.core.queue.local] Missing package metadata: ${missing.join(', ')}. Please update package.json.`;
    console.error(message);
    process.exit(1);
}

process.exit(0);
