/**
 * Patch ux35.switch_to_* keys into all locale files.
 * Run: node web-nodejs/scripts/patch-ux35-shell-switch-i18n.js
 */
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'lang');

const translations = {
  en: {
    switch_to_ux35: 'Switch to UX 3.5',
    switch_to_classic: 'Switch to classic UI'
  },
  ar: {
    switch_to_ux35: 'التبديل إلى UX 3.5',
    switch_to_classic: 'التبديل إلى الواجهة الكلاسيكية'
  },
  cs: {
    switch_to_ux35: 'Přepnout na UX 3.5',
    switch_to_classic: 'Přepnout na klasické rozhraní'
  },
  da: {
    switch_to_ux35: 'Skift til UX 3.5',
    switch_to_classic: 'Skift til klassisk UI'
  },
  de: {
    switch_to_ux35: 'Zu UX 3.5 wechseln',
    switch_to_classic: 'Zur klassischen Oberfläche wechseln'
  },
  es: {
    switch_to_ux35: 'Cambiar a UX 3.5',
    switch_to_classic: 'Cambiar a la interfaz clásica'
  },
  fi: {
    switch_to_ux35: 'Vaihda UX 3.5 -tilaan',
    switch_to_classic: 'Vaihda klassiseen käyttöliittymään'
  },
  fr: {
    switch_to_ux35: 'Passer à UX 3.5',
    switch_to_classic: 'Passer à l’interface classique'
  },
  hi: {
    switch_to_ux35: 'UX 3.5 पर स्विच करें',
    switch_to_classic: 'क्लासिक UI पर स्विच करें'
  },
  hu: {
    switch_to_ux35: 'Váltás UX 3.5-re',
    switch_to_classic: 'Váltás klasszikus felületre'
  },
  id: {
    switch_to_ux35: 'Beralih ke UX 3.5',
    switch_to_classic: 'Beralih ke UI klasik'
  },
  it: {
    switch_to_ux35: 'Passa a UX 3.5',
    switch_to_classic: 'Passa all’interfaccia classica'
  },
  ja: {
    switch_to_ux35: 'UX 3.5 に切り替え',
    switch_to_classic: 'クラシック UI に切り替え'
  },
  ko: {
    switch_to_ux35: 'UX 3.5로 전환',
    switch_to_classic: '클래식 UI로 전환'
  },
  nb: {
    switch_to_ux35: 'Bytt til UX 3.5',
    switch_to_classic: 'Bytt til klassisk UI'
  },
  nl: {
    switch_to_ux35: 'Overschakelen naar UX 3.5',
    switch_to_classic: 'Overschakelen naar klassieke UI'
  },
  pl: {
    switch_to_ux35: 'Przełącz na UX 3.5',
    switch_to_classic: 'Przełącz na klasyczny interfejs'
  },
  pt: {
    switch_to_ux35: 'Mudar para UX 3.5',
    switch_to_classic: 'Mudar para a interface clássica'
  },
  ro: {
    switch_to_ux35: 'Comutați la UX 3.5',
    switch_to_classic: 'Comutați la interfața clasică'
  },
  sv: {
    switch_to_ux35: 'Växla till UX 3.5',
    switch_to_classic: 'Växla till klassiskt gränssnitt'
  },
  th: {
    switch_to_ux35: 'สลับไป UX 3.5',
    switch_to_classic: 'สลับไป UI คลาสสิก'
  },
  tr: {
    switch_to_ux35: 'UX 3.5’e geç',
    switch_to_classic: 'Klasik arayüze geç'
  },
  uk: {
    switch_to_ux35: 'Перемкнути на UX 3.5',
    switch_to_classic: 'Перемкнути на класичний інтерфейс'
  },
  vi: {
    switch_to_ux35: 'Chuyển sang UX 3.5',
    switch_to_classic: 'Chuyển sang giao diện cổ điển'
  },
  zh: {
    switch_to_ux35: '切换到 UX 3.5',
    switch_to_classic: '切换到经典界面'
  },
  'zh-TW': {
    switch_to_ux35: '切換至 UX 3.5',
    switch_to_classic: '切換至經典介面'
  }
};

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const code = file.replace('.json', '');
  const p = path.join(dir, file);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const t = translations[code] || translations.en;
  if (!j.ux35) j.ux35 = {};
  j.ux35.switch_to_ux35 = t.switch_to_ux35;
  j.ux35.switch_to_classic = t.switch_to_classic;
  fs.writeFileSync(p, JSON.stringify(j, null, 4) + '\n');
  console.log('updated', code);
}
