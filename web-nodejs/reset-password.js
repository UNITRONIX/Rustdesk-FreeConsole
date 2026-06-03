#!/usr/bin/env node
'use strict';

/**
 * @deprecated Use scripts/reset-password.js — this file targeted db_v2.sqlite3, not panel auth.db.
 */
console.error('This script is deprecated. Use: node scripts/reset-password.js [newPassword]');
console.error('Panel passwords are stored in data/auth.db (SQLite) or PostgreSQL users table.');
process.exit(1);
