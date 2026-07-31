/**
 * Patch ux35 Beta labeling into all locale files.
 * Run: node web-nodejs/scripts/patch-ux35-beta-label-i18n.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'lang');

const translations = {
  en: {
    switch_to_ux35: 'Switch to UX 3.5 (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Beta console layout — optional; classic UI remains the default.'
  },
  ar: {
    switch_to_ux35: 'التبديل إلى UX 3.5 (تجريبي)',
    beta_badge: 'تجريبي',
    beta_tooltip: 'تخطيط لوحة تجريبي — اختياري؛ تبقى الواجهة الكلاسيكية الافتراضية.'
  },
  cs: {
    switch_to_ux35: 'Přepnout na UX 3.5 (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Beta rozložení konzole — volitelné; výchozí zůstává klasické UI.'
  },
  da: {
    switch_to_ux35: 'Skift til UX 3.5 (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Beta-konsollayout — valgfrit; klassisk UI forbliver standard.'
  },
  de: {
    switch_to_ux35: 'Zu UX 3.5 wechseln (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Beta-Konsolenlayout — optional; die klassische Oberfläche bleibt Standard.'
  },
  es: {
    switch_to_ux35: 'Cambiar a UX 3.5 (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Diseño de consola en beta — opcional; la interfaz clásica sigue siendo la predeterminada.'
  },
  fi: {
    switch_to_ux35: 'Vaihda UX 3.5 -tilaan (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Beta-konsolin asettelu — valinnainen; klassinen käyttöliittymä pysyy oletuksena.'
  },
  fr: {
    switch_to_ux35: 'Passer à UX 3.5 (Bêta)',
    beta_badge: 'BÊTA',
    beta_tooltip: 'Disposition console en bêta — optionnelle ; l’interface classique reste la valeur par défaut.'
  },
  hi: {
    switch_to_ux35: 'UX 3.5 पर स्विच करें (बीटा)',
    beta_badge: 'बीटा',
    beta_tooltip: 'बीटा कंसोल लेआउट — वैकल्पिक; क्लासिक UI डिफ़ॉल्ट रहता है।'
  },
  hu: {
    switch_to_ux35: 'Váltás UX 3.5-re (Béta)',
    beta_badge: 'BÉTA',
    beta_tooltip: 'Béta konzol elrendezés — opcionális; az alapértelmezett a klasszikus felület marad.'
  },
  id: {
    switch_to_ux35: 'Beralih ke UX 3.5 (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Tata letak konsol Beta — opsional; UI klasik tetap default.'
  },
  it: {
    switch_to_ux35: 'Passa a UX 3.5 (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Layout console in beta — opzionale; l’interfaccia classica resta predefinita.'
  },
  ja: {
    switch_to_ux35: 'UX 3.5 に切り替え（ベータ）',
    beta_badge: 'ベータ',
    beta_tooltip: 'ベータ版コンソールレイアウト — 任意。既定はクラシック UI のままです。'
  },
  ko: {
    switch_to_ux35: 'UX 3.5로 전환 (베타)',
    beta_badge: '베타',
    beta_tooltip: '베타 콘솔 레이아웃 — 선택 사항이며 기본값은 클래식 UI입니다.'
  },
  nb: {
    switch_to_ux35: 'Bytt til UX 3.5 (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Beta-konsollayout — valgfritt; klassisk UI forblir standard.'
  },
  nl: {
    switch_to_ux35: 'Overschakelen naar UX 3.5 (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Beta-consolelay-out — optioneel; de klassieke UI blijft de standaard.'
  },
  pl: {
    switch_to_ux35: 'Przełącz na UX 3.5 (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Układ konsoli w wersji beta — opcjonalny; klasyczny UI pozostaje domyślny.'
  },
  pt: {
    switch_to_ux35: 'Mudar para UX 3.5 (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Layout da consola em beta — opcional; a UI clássica continua a ser a predefinida.'
  },
  ro: {
    switch_to_ux35: 'Comutați la UX 3.5 (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Aspect consolă beta — opțional; UI-ul clasic rămâne implicit.'
  },
  sv: {
    switch_to_ux35: 'Växla till UX 3.5 (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Beta-konsollayout — valfritt; klassiskt UI förblir standard.'
  },
  th: {
    switch_to_ux35: 'สลับไป UX 3.5 (เบต้า)',
    beta_badge: 'เบต้า',
    beta_tooltip: 'เลย์เอาต์คอนโซลเบต้า — ไม่บังคับ UI คลาสสิกยังเป็นค่าเริ่มต้น'
  },
  tr: {
    switch_to_ux35: 'UX 3.5’e geç (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Beta konsol düzeni — isteğe bağlı; klasik arayüz varsayılan kalır.'
  },
  uk: {
    switch_to_ux35: 'Перемкнути на UX 3.5 (Бета)',
    beta_badge: 'БЕТА',
    beta_tooltip: 'Бета-макет консолі — необов’язково; класичний UI лишається типовим.'
  },
  vi: {
    switch_to_ux35: 'Chuyển sang UX 3.5 (Beta)',
    beta_badge: 'BETA',
    beta_tooltip: 'Bố cục console Beta — tùy chọn; giao diện cổ điển vẫn là mặc định.'
  },
  zh: {
    switch_to_ux35: '切换到 UX 3.5（测试版）',
    beta_badge: '测试版',
    beta_tooltip: '测试版控制台布局 — 可选；经典界面仍为默认。'
  },
  'zh-TW': {
    switch_to_ux35: '切換至 UX 3.5（測試版）',
    beta_badge: '測試版',
    beta_tooltip: '測試版主控台版面 — 可選；經典介面仍為預設。'
  }
};

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const code = file.replace('.json', '');
  const p = path.join(dir, file);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const t = translations[code] || translations.en;
  if (!j.ux35) j.ux35 = {};
  j.ux35.switch_to_ux35 = t.switch_to_ux35;
  j.ux35.beta_badge = t.beta_badge;
  j.ux35.beta_tooltip = t.beta_tooltip;
  fs.writeFileSync(p, JSON.stringify(j, null, 4) + '\n');
  console.log('updated', code);
}
