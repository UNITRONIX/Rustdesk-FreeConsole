#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const LANG_DIR = path.join(__dirname, '..', 'lang');

const PATCHES = {
    ar: {
        short_link: 'رابط تنزيل قصير',
        short_link_hint: 'يُستخدم في عنوان URL العام (/d/…). أحرف صغيرة وأرقام وشرطات فقط (2–32 حرفًا). يُملأ تلقائيًا من اسم الحزمة — اختصره لتسهيل المشاركة (مثل acme).',
        download_link_suffix: ' روابط hex القديمة تظل تعمل بعد تغيير الرابط القصير.',
        slug_invalid: 'يجب أن يحتوي الرابط القصير على أحرف صغيرة وأرقام وشرطات فقط',
        slug_too_short: 'يجب أن يكون الرابط القصير حرفين على الأقل',
        slug_too_long: 'يجب ألا يزيد الرابط القصير عن 32 حرفًا',
        slug_taken: 'هذا الرابط القصير مستخدم بالفعل في حزمة أخرى',
    },
    cs: {
        short_link: 'Krátký odkaz ke stažení',
        short_link_hint: 'Používá se ve veřejné URL (/d/…). Pouze malá písmena, číslice a pomlčky (2–32 znaků). Automaticky vyplněno z názvu balíčku — zkrácením usnadníte sdílení (např. acme).',
        download_link_suffix: ' Staré hex odkazy nadále fungují i po změně krátkého odkazu.',
        slug_invalid: 'Krátký odkaz smí obsahovat pouze malá písmena, číslice a pomlčky',
        slug_too_short: 'Krátký odkaz musí mít alespoň 2 znaky',
        slug_too_long: 'Krátký odkaz smí mít nejvýše 32 znaků',
        slug_taken: 'Tento krátký odkaz již používá jiný balíček',
    },
    da: {
        short_link: 'Kort downloadlink',
        short_link_hint: 'Bruges i den offentlige URL (/d/…). Kun små bogstaver, tal og bindestreger (2–32 tegn). Udfyldes automatisk fra pakkenavn — forkort for nemmere deling (f.eks. acme).',
        download_link_suffix: ' Gamle hex-links virker stadig efter ændring af det korte link.',
        slug_invalid: 'Kort link må kun indeholde små bogstaver, tal og bindestreger',
        slug_too_short: 'Kort link skal være mindst 2 tegn',
        slug_too_long: 'Kort link må højst være 32 tegn',
        slug_taken: 'Dette korte link bruges allerede af en anden pakke',
    },
    de: {
        short_link: 'Kurzer Download-Link',
        short_link_hint: 'Wird in der öffentlichen URL (/d/…) verwendet. Nur Kleinbuchstaben, Zahlen und Bindestriche (2–32 Zeichen). Wird automatisch aus dem Paketnamen übernommen — kürzen Sie ihn für einfacheres Teilen (z. B. acme).',
        download_link_suffix: ' Alte Hex-Links funktionieren weiterhin, wenn Sie den kurzen Link ändern.',
        slug_invalid: 'Der kurze Link darf nur Kleinbuchstaben, Zahlen und Bindestriche enthalten',
        slug_too_short: 'Der kurze Link muss mindestens 2 Zeichen haben',
        slug_too_long: 'Der kurze Link darf höchstens 32 Zeichen haben',
        slug_taken: 'Dieser kurze Link wird bereits von einem anderen Paket verwendet',
    },
    es: {
        short_link: 'Enlace de descarga corto',
        short_link_hint: 'Se usa en la URL pública (/d/…). Solo letras minúsculas, números y guiones (2–32 caracteres). Se rellena automáticamente desde el nombre del paquete — acórtelo para compartirlo más fácilmente (p. ej. acme).',
        download_link_suffix: ' Los enlaces hex antiguos siguen funcionando después de cambiar el enlace corto.',
        slug_invalid: 'El enlace corto solo puede contener letras minúsculas, números y guiones',
        slug_too_short: 'El enlace corto debe tener al menos 2 caracteres',
        slug_too_long: 'El enlace corto debe tener como máximo 32 caracteres',
        slug_taken: 'Este enlace corto ya lo usa otro paquete',
    },
    fi: {
        short_link: 'Lyhyt latauslinkki',
        short_link_hint: 'Käytetään julkisessa URL-osoitteessa (/d/…). Vain pienet kirjaimet, numerot ja yhdysmerkit (2–32 merkkiä). Täytetään automaattisesti paketin nimestä — lyhennä helpompaa jakamista varten (esim. acme).',
        download_link_suffix: ' Vanhat hex-linkit toimivat edelleen lyhyen linkin vaihtamisen jälkeen.',
        slug_invalid: 'Lyhyt linkki saa sisältää vain pieniä kirjaimia, numeroita ja yhdysmerkkejä',
        slug_too_short: 'Lyhyen linkin on oltava vähintään 2 merkkiä',
        slug_too_long: 'Lyhyt linkki saa olla enintään 32 merkkiä',
        slug_taken: 'Tämä lyhyt linkki on jo toisen paketin käytössä',
    },
    fr: {
        short_link: 'Lien de téléchargement court',
        short_link_hint: 'Utilisé dans l’URL publique (/d/…). Lettres minuscules, chiffres et tirets uniquement (2–32 caractères). Rempli automatiquement à partir du nom du paquet — raccourcissez-le pour faciliter le partage (p. ex. acme).',
        download_link_suffix: ' Les anciens liens hex continuent de fonctionner après modification du lien court.',
        slug_invalid: 'Le lien court ne peut contenir que des lettres minuscules, des chiffres et des tirets',
        slug_too_short: 'Le lien court doit comporter au moins 2 caractères',
        slug_too_long: 'Le lien court doit comporter au maximum 32 caractères',
        slug_taken: 'Ce lien court est déjà utilisé par un autre paquet',
    },
    hi: {
        short_link: 'लघु डाउनलोड लिंक',
        short_link_hint: 'सार्वजनिक URL (/d/…) में उपयोग होता है। केवल छोटे अक्षर, संख्याएँ और डैश (2–32 वर्ण)। बंडल नाम से स्वतः भरा जाता है — साझा करना आसान बनाने के लिए छोटा करें (जैसे acme)।',
        download_link_suffix: ' छोटा लिंक बदलने के बाद भी पुराने hex लिंक काम करते रहेंगे।',
        slug_invalid: 'लघु लिंक में केवल छोटे अक्षर, संख्याएँ और डैश हो सकते हैं',
        slug_too_short: 'लघु लिंक कम से कम 2 वर्ण का होना चाहिए',
        slug_too_long: 'लघु लिंक अधिकतम 32 वर्ण का हो सकता है',
        slug_taken: 'यह लघु लिंक पहले से किसी अन्य बंडल द्वारा उपयोग में है',
    },
    hu: {
        short_link: 'Rövid letöltési link',
        short_link_hint: 'A nyilvános URL-ben (/d/…) használatos. Csak kisbetűk, számok és kötőjelek (2–32 karakter). Automatikusan kitöltődik a csomag nevéből — rövidítse könnyebb megosztáshoz (pl. acme).',
        download_link_suffix: ' A régi hex linkek továbbra is működnek a rövid link módosítása után.',
        slug_invalid: 'A rövid link csak kisbetűket, számokat és kötőjeleket tartalmazhat',
        slug_too_short: 'A rövid linknek legalább 2 karakterből kell állnia',
        slug_too_long: 'A rövid link legfeljebb 32 karakter lehet',
        slug_taken: 'Ezt a rövid linket már egy másik csomag használja',
    },
    id: {
        short_link: 'Tautan unduhan pendek',
        short_link_hint: 'Digunakan di URL publik (/d/…). Hanya huruf kecil, angka, dan tanda hubung (2–32 karakter). Diisi otomatis dari nama paket — persingkat untuk memudahkan berbagi (mis. acme).',
        download_link_suffix: ' Tautan hex lama tetap berfungsi setelah Anda mengubah tautan pendek.',
        slug_invalid: 'Tautan pendek hanya boleh berisi huruf kecil, angka, dan tanda hubung',
        slug_too_short: 'Tautan pendek harus minimal 2 karakter',
        slug_too_long: 'Tautan pendek maksimal 32 karakter',
        slug_taken: 'Tautan pendek ini sudah digunakan paket lain',
    },
    it: {
        short_link: 'Link di download breve',
        short_link_hint: 'Usato nell’URL pubblico (/d/…). Solo lettere minuscole, numeri e trattini (2–32 caratteri). Compilato automaticamente dal nome del pacchetto — abbrevialo per condividerlo più facilmente (es. acme).',
        download_link_suffix: ' I vecchi link hex continuano a funzionare dopo la modifica del link breve.',
        slug_invalid: 'Il link breve può contenere solo lettere minuscole, numeri e trattini',
        slug_too_short: 'Il link breve deve avere almeno 2 caratteri',
        slug_too_long: 'Il link breve può avere al massimo 32 caratteri',
        slug_taken: 'Questo link breve è già usato da un altro pacchetto',
    },
    ja: {
        short_link: '短いダウンロードリンク',
        short_link_hint: '公開 URL (/d/…) で使用されます。小文字、数字、ハイフンのみ（2〜32 文字）。バンドル名から自動入力 — 共有しやすくするため短くできます（例: acme）。',
        download_link_suffix: ' 短いリンクを変更しても、古い hex リンクは引き続き利用できます。',
        slug_invalid: '短いリンクには小文字、数字、ハイフンのみ使用できます',
        slug_too_short: '短いリンクは 2 文字以上必要です',
        slug_too_long: '短いリンクは最大 32 文字です',
        slug_taken: 'この短いリンクは別のバンドルで既に使用されています',
    },
    ko: {
        short_link: '짧은 다운로드 링크',
        short_link_hint: '공개 URL(/d/…)에 사용됩니다. 소문자, 숫자, 하이픈만 가능(2–32자). 번들 이름에서 자동 입력 — 공유하기 쉽게 줄이세요(예: acme).',
        download_link_suffix: ' 짧은 링크를 변경해도 이전 hex 링크는 계속 작동합니다.',
        slug_invalid: '짧은 링크는 소문자, 숫자, 하이픈만 포함할 수 있습니다',
        slug_too_short: '짧은 링크는 최소 2자여야 합니다',
        slug_too_long: '짧은 링크는 최대 32자입니다',
        slug_taken: '이 짧은 링크는 다른 번들에서 이미 사용 중입니다',
    },
    nb: {
        short_link: 'Kort nedlastingslenke',
        short_link_hint: 'Brukes i den offentlige URL-en (/d/…). Kun små bokstaver, tall og bindestreker (2–32 tegn). Fylles automatisk fra pakkenavn — forkort for enklere deling (f.eks. acme).',
        download_link_suffix: ' Gamle hex-lenker fungerer fortsatt etter at du endrer den korte lenken.',
        slug_invalid: 'Kort lenke kan bare inneholde små bokstaver, tall og bindestreker',
        slug_too_short: 'Kort lenke må være minst 2 tegn',
        slug_too_long: 'Kort lenke kan være maks 32 tegn',
        slug_taken: 'Denne korte lenken brukes allerede av en annen pakke',
    },
    nl: {
        short_link: 'Korte downloadlink',
        short_link_hint: 'Gebruikt in de openbare URL (/d/…). Alleen kleine letters, cijfers en streepjes (2–32 tekens). Automatisch ingevuld vanuit pakketnaam — verkort voor eenvoudiger delen (bijv. acme).',
        download_link_suffix: ' Oude hex-links blijven werken nadat u de korte link wijzigt.',
        slug_invalid: 'Korte link mag alleen kleine letters, cijfers en streepjes bevatten',
        slug_too_short: 'Korte link moet minimaal 2 tekens zijn',
        slug_too_long: 'Korte link mag maximaal 32 tekens zijn',
        slug_taken: 'Deze korte link wordt al door een ander pakket gebruikt',
    },
    pt: {
        short_link: 'Link de download curto',
        short_link_hint: 'Usado na URL pública (/d/…). Apenas letras minúsculas, números e hífens (2–32 caracteres). Preenchido automaticamente a partir do nome do pacote — encurte para facilitar o compartilhamento (ex.: acme).',
        download_link_suffix: ' Links hex antigos continuam funcionando após alterar o link curto.',
        slug_invalid: 'O link curto só pode conter letras minúsculas, números e hífens',
        slug_too_short: 'O link curto deve ter pelo menos 2 caracteres',
        slug_too_long: 'O link curto deve ter no máximo 32 caracteres',
        slug_taken: 'Este link curto já é usado por outro pacote',
    },
    ro: {
        short_link: 'Link de descărcare scurt',
        short_link_hint: 'Folosit în URL-ul public (/d/…). Doar litere mici, cifre și cratime (2–32 caractere). Completat automat din numele pachetului — scurtați-l pentru partajare mai ușoară (ex. acme).',
        download_link_suffix: ' Linkurile hex vechi funcționează în continuare după schimbarea linkului scurt.',
        slug_invalid: 'Linkul scurt poate conține doar litere mici, cifre și cratime',
        slug_too_short: 'Linkul scurt trebuie să aibă cel puțin 2 caractere',
        slug_too_long: 'Linkul scurt poate avea cel mult 32 de caractere',
        slug_taken: 'Acest link scurt este deja folosit de alt pachet',
    },
    sv: {
        short_link: 'Kort nedladdningslänk',
        short_link_hint: 'Används i den offentliga URL:en (/d/…). Endast små bokstäver, siffror och bindestreck (2–32 tecken). Fylls i automatiskt från paketnamn — förkorta för enklare delning (t.ex. acme).',
        download_link_suffix: ' Gamla hex-länkar fungerar fortfarande efter att du ändrat den korta länken.',
        slug_invalid: 'Kort länk får bara innehålla små bokstäver, siffror och bindestreck',
        slug_too_short: 'Kort länk måste vara minst 2 tecken',
        slug_too_long: 'Kort länk får vara högst 32 tecken',
        slug_taken: 'Denna korta länk används redan av ett annat paket',
    },
    th: {
        short_link: 'ลิงก์ดาวน์โหลดแบบสั้น',
        short_link_hint: 'ใช้ใน URL สาธารณะ (/d/…) ใช้ได้เฉพาะตัวพิมพ์เล็ก ตัวเลข และขีดกลาง (2–32 ตัวอักษร) กรอกอัตโนมัติจากชื่อแพ็กเกจ — ย่อให้สั้นเพื่อแชร์ง่าย (เช่น acme)',
        download_link_suffix: ' ลิงก์ hex เก่ายังใช้งานได้หลังเปลี่ยนลิงก์สั้น',
        slug_invalid: 'ลิงก์สั้นต้องมีเฉพาะตัวพิมพ์เล็ก ตัวเลข และขีดกลาง',
        slug_too_short: 'ลิงก์สั้นต้องมีอย่างน้อย 2 ตัวอักษร',
        slug_too_long: 'ลิงก์สั้นต้องไม่เกิน 32 ตัวอักษร',
        slug_taken: 'ลิงก์สั้นนี้ถูกใช้โดยแพ็กเกจอื่นแล้ว',
    },
    tr: {
        short_link: 'Kısa indirme bağlantısı',
        short_link_hint: 'Genel URL’de (/d/…) kullanılır. Yalnızca küçük harfler, rakamlar ve tireler (2–32 karakter). Paket adından otomatik doldurulur — paylaşımı kolaylaştırmak için kısaltın (örn. acme).',
        download_link_suffix: ' Kısa bağlantıyı değiştirdikten sonra eski hex bağlantılar çalışmaya devam eder.',
        slug_invalid: 'Kısa bağlantı yalnızca küçük harf, rakam ve tire içerebilir',
        slug_too_short: 'Kısa bağlantı en az 2 karakter olmalıdır',
        slug_too_long: 'Kısa bağlantı en fazla 32 karakter olabilir',
        slug_taken: 'Bu kısa bağlantı başka bir paket tarafından zaten kullanılıyor',
    },
    uk: {
        short_link: 'Коротке посилання для завантаження',
        short_link_hint: 'Використовується в публічній URL (/d/…). Лише малі літери, цифри та дефіси (2–32 символи). Автозаповнення з назви пакета — скоротіть для зручнішого поширення (напр. acme).',
        download_link_suffix: ' Старі hex-посилання працюють і після зміни короткого посилання.',
        slug_invalid: 'Коротке посилання може містити лише малі літери, цифри та дефіси',
        slug_too_short: 'Коротке посилання має містити щонайменше 2 символи',
        slug_too_long: 'Коротке посилання може містити щонайбільше 32 символи',
        slug_taken: 'Це коротке посилання вже використовує інший пакет',
    },
    vi: {
        short_link: 'Liên kết tải xuống ngắn',
        short_link_hint: 'Dùng trong URL công khai (/d/…). Chỉ chữ thường, số và dấu gạch ngang (2–32 ký tự). Tự điền từ tên gói — rút ngắn để chia sẻ dễ hơn (vd. acme).',
        download_link_suffix: ' Liên kết hex cũ vẫn hoạt động sau khi bạn đổi liên kết ngắn.',
        slug_invalid: 'Liên kết ngắn chỉ được chứa chữ thường, số và dấu gạch ngang',
        slug_too_short: 'Liên kết ngắn phải có ít nhất 2 ký tự',
        slug_too_long: 'Liên kết ngắn tối đa 32 ký tự',
        slug_taken: 'Liên kết ngắn này đã được gói khác sử dụng',
    },
    zh: {
        short_link: '短下载链接',
        short_link_hint: '用于公开 URL（/d/…）。仅小写字母、数字和连字符（2–32 个字符）。从安装包名称自动填充 — 可缩短以便分享（例如 acme）。',
        download_link_suffix: ' 更改短链接后，旧的 hex 链接仍然有效。',
        slug_invalid: '短链接只能包含小写字母、数字和连字符',
        slug_too_short: '短链接至少需要 2 个字符',
        slug_too_long: '短链接最多 32 个字符',
        slug_taken: '此短链接已被其他安装包使用',
    },
    'zh-TW': {
        short_link: '短下載連結',
        short_link_hint: '用於公開 URL（/d/…）。僅小寫字母、數字和連字號（2–32 個字元）。從套件名稱自動填入 — 可縮短以便分享（例如 acme）。',
        download_link_suffix: ' 變更短連結後，舊的 hex 連結仍可正常使用。',
        slug_invalid: '短連結只能包含小寫字母、數字和連字號',
        slug_too_short: '短連結至少需要 2 個字元',
        slug_too_long: '短連結最多 32 個字元',
        slug_taken: '此短連結已被其他套件使用',
    },
};

function patchFile(lang, patch) {
    const file = path.join(LANG_DIR, `${lang}.json`);
    let raw = fs.readFileSync(file, 'utf8');
    let changed = false;

    if (!raw.includes('"short_link"')) {
        raw = raw.replace(
            /("bundle_name_hint": "[^"]*",)\n(\s*)("(?:branding_section|connection_section)":)/,
            `$1\n$2"short_link": ${JSON.stringify(patch.short_link)},\n$2"short_link_hint": ${JSON.stringify(patch.short_link_hint)},\n$2$3`
        );
        changed = true;
    }

    if (!raw.includes('Old hex links') && !raw.includes('hex') && raw.includes('"download_link_hint"')) {
        // append suffix if not already extended
    }
    const hintMatch = raw.match(/"download_link_hint": "([^"]*)"/);
    if (hintMatch && !hintMatch[1].includes('hex') && !hintMatch[1].includes('Hex') && !hintMatch[1].includes('hex-')) {
        const updated = hintMatch[1] + patch.download_link_suffix;
        raw = raw.replace(hintMatch[0], `"download_link_hint": ${JSON.stringify(updated)}`);
        changed = true;
    }

    if (!raw.includes('"slug_invalid"')) {
        const slugBlock = [
            `"slug_invalid": ${JSON.stringify(patch.slug_invalid)}`,
            `"slug_too_short": ${JSON.stringify(patch.slug_too_short)}`,
            `"slug_too_long": ${JSON.stringify(patch.slug_too_long)}`,
            `"slug_taken": ${JSON.stringify(patch.slug_taken)}`,
        ].join(',\n      ');
        const slugAfterTokenFailed = /(      "token_failed": "[^"]*")(\n    \},\n    "legacy_title")/;
        if (slugAfterTokenFailed.test(raw)) {
            raw = raw.replace(slugAfterTokenFailed, `$1,\n      ${slugBlock}$2`);
        } else if (/("rebuild_revoked": "[^"]*"),(\n\s*)(\}\s*,\n\s*"legacy_title")/.test(raw)) {
            raw = raw.replace(
                /("rebuild_revoked": "[^"]*"),(\n\s*)(\}\s*,\n\s*"legacy_title")/,
                `$1,\n      ${slugBlock}$2$3`
            );
        } else {
            raw = raw.replace(
                /("rebuild_revoked": "[^"]*")(\n\s*\},)/,
                `$1,\n      ${slugBlock}$2`
            );
        }
        changed = true;
    }

    if (changed) {
        fs.writeFileSync(file, raw, 'utf8');
        console.log(`patched ${lang}.json`);
    } else {
        console.log(`skipped ${lang}.json (already complete)`);
    }
}

for (const [lang, patch] of Object.entries(PATCHES)) {
    patchFile(lang, patch);
}
