#!/usr/bin/env node
/**
 * Build support-agent locale JSON files from en.json, web-nodejs/lang/*.json,
 * and locales/supplemental.json (strings without a console equivalent).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const webDir = path.join(root, '..', 'web-nodejs', 'lang');
const localesDir = path.join(root, 'locales');

const LANGS = [
  'ar', 'cs', 'da', 'de', 'en', 'es', 'fi', 'fr', 'hi', 'hu', 'id', 'it',
  'ja', 'ko', 'nb', 'nl', 'pl', 'pt', 'ro', 'sv', 'th', 'tr', 'uk', 'vi',
  'zh', 'zh-TW',
];

const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en.json'), 'utf8'));
const supplemental = JSON.parse(
  fs.readFileSync(path.join(localesDir, 'supplemental.json'), 'utf8'),
);

function get(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** Map support-agent keys to web-nodejs JSON paths. */
const WEB_MAP = {
  save: (w) => get(w, 'common', 'save'),
  cancel: (w) => get(w, 'common', 'cancel'),
  close: (w) => get(w, 'common', 'close'),
  copied: (w) => get(w, 'common', 'copied'),
  copy: (w) => get(w, 'actions', 'copy'),
  settings: (w) => get(w, 'nav', 'settings'),
  send: (w) => get(w, 'chat', 'send'),
  chat_title: (w) => get(w, 'chat', 'title'),
  chat_send: (w) => get(w, 'chat', 'send'),
  chat_placeholder: (w) => get(w, 'chat', 'type_message'),
  chat_empty: (w) => get(w, 'chat', 'no_messages'),
  your_id: (w) => get(w, 'generator', 'preview_id'),
  access_password: (w) => get(w, 'generator', 'preview_password'),
  chat_with_support: (w) => get(w, 'generator', 'preview_chat'),
  request_help: (w) => get(w, 'generator', 'preview_help'),
  status_ready: (w) => get(w, 'generator', 'preview_status_ready'),
  connected: (w) => get(w, 'cdap', 'connected'),
  disconnected: (w) => get(w, 'remote', 'connecting'),
  settings_language: (w) => get(w, 'settings', 'language'),
  enrollment_pending: (w) => get(w, 'registrations', 'status_pending'),
  enrollment_rejected: (w) => get(w, 'registrations', 'status_rejected'),
  consent_accept: (w) => get(w, 'registrations', 'approve_btn'),
  consent_deny: (w) => get(w, 'registrations', 'reject_btn'),
};

for (const lang of LANGS) {
  let web = {};
  const webPath = path.join(webDir, `${lang}.json`);
  if (fs.existsSync(webPath)) {
    web = JSON.parse(fs.readFileSync(webPath, 'utf8'));
  }
  const sup = supplemental[lang] || supplemental.en || {};
  const out = {};
  for (const key of Object.keys(en)) {
    out[key] =
      sup[key] ||
      WEB_MAP[key]?.(web) ||
      (lang === 'en' ? en[key] : undefined) ||
      en[key];
  }
  fs.writeFileSync(
    path.join(localesDir, `${lang}.json`),
    JSON.stringify(out, null, 2) + '\n',
  );
  console.log('wrote', lang);
}
