const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'lang');
const translations = {
  ar: { custom: 'مخصص', resize_sidebar: 'تغيير عرض الشريط الجانبي', open_menu: 'فتح القائمة', theme_mode_hint: 'الفاتح والداكن مدمجان. يُفعَّل المخصص عند تعديل الألوان أدناه.' },
  cs: { custom: 'Vlastní', resize_sidebar: 'Změnit šířku postranního panelu', open_menu: 'Otevřít nabídku', theme_mode_hint: 'Světlý a tmavý jsou vestavěné. Vlastní se aktivuje při úpravě barev níže.' },
  da: { custom: 'Tilpasset', resize_sidebar: 'Tilpas sidepanelbredde', open_menu: 'Åbn menu', theme_mode_hint: 'Lys og mørk er indbygget. Tilpasset aktiveres, når du redigerer farverne nedenfor.' },
  de: { custom: 'Benutzerdefiniert', resize_sidebar: 'Seitenleiste skalieren', open_menu: 'Menü öffnen', theme_mode_hint: 'Hell und Dunkel sind integriert. Benutzerdefiniert wird aktiviert, wenn Sie unten Farben ändern.' },
  es: { custom: 'Personalizado', resize_sidebar: 'Cambiar ancho de la barra lateral', open_menu: 'Abrir menú', theme_mode_hint: 'Claro y Oscuro son predefinidos. Personalizado se activa al editar los colores abajo.' },
  fi: { custom: 'Mukautettu', resize_sidebar: 'Muuta sivupalkin leveyttä', open_menu: 'Avaa valikko', theme_mode_hint: 'Vaalea ja Tumma ovat sisäänrakennettuja. Mukautettu otetaan käyttöön, kun muokkaat värejä alla.' },
  fr: { custom: 'Personnalisé', resize_sidebar: 'Redimensionner la barre latérale', open_menu: 'Ouvrir le menu', theme_mode_hint: 'Clair et Sombre sont intégrés. Personnalisé s’active lorsque vous modifiez les couleurs ci-dessous.' },
  hi: { custom: 'कस्टम', resize_sidebar: 'साइडबार की चौड़ाई बदलें', open_menu: 'मेनू खोलें', theme_mode_hint: 'लाइट और डार्क बिल्ट-इन हैं। नीचे रंग बदलने पर कस्टम सक्रिय होता है।' },
  hu: { custom: 'Egyéni', resize_sidebar: 'Oldalsáv átméretezése', open_menu: 'Menü megnyitása', theme_mode_hint: 'A Világos és a Sötét beépített. Az Egyéni a színek szerkesztésekor aktiválódik.' },
  id: { custom: 'Kustom', resize_sidebar: 'Ubah lebar bilah samping', open_menu: 'Buka menu', theme_mode_hint: 'Terang dan Gelap bawaan. Kustom aktif saat Anda mengubah warna di bawah.' },
  it: { custom: 'Personalizzato', resize_sidebar: 'Ridimensiona barra laterale', open_menu: 'Apri menu', theme_mode_hint: 'Chiaro e Scuro sono integrati. Personalizzato si attiva modificando i colori sotto.' },
  ja: { custom: 'カスタム', resize_sidebar: 'サイドバーの幅を変更', open_menu: 'メニューを開く', theme_mode_hint: 'ライトとダークは標準です。下で色を編集するとカスタムになります。' },
  ko: { custom: '사용자 지정', resize_sidebar: '사이드바 너비 조절', open_menu: '메뉴 열기', theme_mode_hint: '밝게와 어둡게는 기본입니다. 아래에서 색상을 편집하면 사용자 지정이 활성화됩니다.' },
  nb: { custom: 'Tilpasset', resize_sidebar: 'Endre sidepanelbredde', open_menu: 'Åpne meny', theme_mode_hint: 'Lys og Mørk er innebygd. Tilpasset aktiveres når du redigerer fargene nedenfor.' },
  nl: { custom: 'Aangepast', resize_sidebar: 'Zijbalkbreedte aanpassen', open_menu: 'Menu openen', theme_mode_hint: 'Licht en Donker zijn ingebouwd. Aangepast wordt actief wanneer u hieronder kleuren bewerkt.' },
  pl: { custom: 'Niestandardowy', resize_sidebar: 'Zmień szerokość paska bocznego', open_menu: 'Otwórz menu', theme_mode_hint: 'Jasny i Ciemny są wbudowane. Niestandardowy włącza się po edycji kolorów poniżej.' },
  pt: { custom: 'Personalizado', resize_sidebar: 'Redimensionar barra lateral', open_menu: 'Abrir menu', theme_mode_hint: 'Claro e Escuro são predefinidos. Personalizado ativa-se ao editar as cores abaixo.' },
  ro: { custom: 'Personalizat', resize_sidebar: 'Redimensionați bara laterală', open_menu: 'Deschide meniul', theme_mode_hint: 'Deschis și Întunecat sunt integrate. Personalizat se activează când editați culorile de mai jos.' },
  sv: { custom: 'Anpassad', resize_sidebar: 'Ändra sidopanelens bredd', open_menu: 'Öppna meny', theme_mode_hint: 'Ljust och Mörkt är inbyggda. Anpassad aktiveras när du redigerar färgerna nedan.' },
  th: { custom: 'กำหนดเอง', resize_sidebar: 'ปรับความกว้างแถบด้านข้าง', open_menu: 'เปิดเมนู', theme_mode_hint: 'สว่างและมืดมีให้ในตัว กำหนดเองจะเปิดเมื่อคุณแก้ไขสีด้านล่าง' },
  tr: { custom: 'Özel', resize_sidebar: 'Kenar çubuğu genişliğini ayarla', open_menu: 'Menüyü aç', theme_mode_hint: 'Açık ve Koyu yerleşiktir. Aşağıdaki renkleri düzenlediğinizde Özel etkinleşir.' },
  uk: { custom: 'Власний', resize_sidebar: 'Змінити ширину бічної панелі', open_menu: 'Відкрити меню', theme_mode_hint: 'Світла і Темна вбудовані. Власний активується під час редагування кольорів нижче.' },
  vi: { custom: 'Tùy chỉnh', resize_sidebar: 'Đổi độ rộng thanh bên', open_menu: 'Mở menu', theme_mode_hint: 'Sáng và Tối là mặc định. Tùy chỉnh bật khi bạn chỉnh màu bên dưới.' },
  zh: { custom: '自定义', resize_sidebar: '调整侧边栏宽度', open_menu: '打开菜单', theme_mode_hint: '浅色和深色为内置。编辑下方颜色时将启用自定义。' },
  'zh-TW': { custom: '自訂', resize_sidebar: '調整側邊欄寬度', open_menu: '開啟選單', theme_mode_hint: '淺色與深色為內建。編輯下方顏色時會啟用自訂。' }
};
const fallback = {
  custom: 'Custom',
  resize_sidebar: 'Resize sidebar',
  open_menu: 'Open menu',
  theme_mode_hint: 'Light and Dark are built-in. Custom activates when you edit colors below.'
};
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'en.json')) {
  const code = file.replace('.json', '');
  const p = path.join(dir, file);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const t = translations[code] || fallback;
  if (!j.theme) j.theme = {};
  j.theme.custom = t.custom;
  j.ux35 = {
    resize_sidebar: t.resize_sidebar,
    open_menu: t.open_menu,
    theme_mode_hint: t.theme_mode_hint
  };
  fs.writeFileSync(p, JSON.stringify(j, null, 4) + '\n');
  console.log('updated', code);
}
