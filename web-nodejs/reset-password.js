#!/usr/bin/env node
'use strict';

/**
 * @deprecated Use scripts/reset-password.js — it updates the selected shared store.
 */
console.error('This script is deprecated. Use: node scripts/reset-password.js [newPassword]');
console.error('Panel passwords are stored in db_v2.sqlite3 (SQLite) or PostgreSQL users table.');
process.exit(1);
