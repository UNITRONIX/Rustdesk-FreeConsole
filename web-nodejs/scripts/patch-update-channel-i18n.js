#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const LANG_DIR = path.join(__dirname, '..', 'lang');

const KEYS = {
    channel_title: {
        ar: 'قناة التحديث', cs: 'Kanál aktualizací', da: 'Opdateringskanal', de: 'Update-Kanal',
        en: 'Update channel', es: 'Canal de actualización', fi: 'Päivityskanava', fr: 'Canal de mise à jour',
        hi: 'अपडेट चैनल', hu: 'Frissítési csatorna', id: 'Saluran pembaruan', it: 'Canale aggiornamenti',
        ja: '更新チャンネル', ko: '업데이트 채널', nb: 'Oppdateringskanal', nl: 'Updatekanaal',
        pl: 'Kanał aktualizacji', pt: 'Canal de atualização', ro: 'Canal de actualizare',
        sv: 'Uppdateringskanal', th: 'ช่องทางอัปเดต', tr: 'Güncelleme kanalı', uk: 'Канал оновлень',
        vi: 'Kênh cập nhật', zh: '更新通道', 'zh-TW': '更新通道'
    },
    channel_desc: {
        ar: 'المستقر يتبع فرع main (إصدارات الإنتاج). التطوير يتبع فرع dev (أحدث العمل قيد التقدم). تغيير القناة يحدد فرع GitHub الذي تُسحب منه التحديثات.',
        cs: 'Stabilní sleduje větev main (produkční vydání). Vývoj sleduje větev dev (rozpracovaná práce). Změna kanálu ovlivní, ze které větve GitHub se stahují aktualizace.',
        da: 'Stable følger main-grenen (produktionsudgivelser). Development følger dev-grenen (seneste igangværende arbejde). Skift af kanal ændrer hvilken GitHub-gren opdateringer hentes fra.',
        de: 'Stable verfolgt den Branch main (Produktions-Releases). Development verfolgt den Branch dev (laufende Entwicklung). Ein Kanalwechsel ändert den GitHub-Branch für Updates.',
        en: 'Stable tracks the main branch (production releases). Development tracks the dev branch (latest work-in-progress). Changing channel affects which GitHub branch updates are pulled from.',
        es: 'Stable sigue la rama main (versiones de producción). Development sigue la rama dev (trabajo en curso). Cambiar el canal afecta desde qué rama de GitHub se obtienen las actualizaciones.',
        fi: 'Stable seuraa main-haaraa (tuotantojulkaisut). Development seuraa dev-haaraa (käynnissä oleva työ). Kanavan vaihto muuttaa mistä GitHub-haarasta päivitykset haetaan.',
        fr: 'Stable suit la branche main (versions de production). Development suit la branche dev (travail en cours). Changer de canal modifie la branche GitHub utilisée pour les mises à jour.',
        hi: 'Stable main शाखा (प्रोडक्शन रिलीज़) का अनुसरण करता है। Development dev शाखा (चल रहा कार्य) का अनुसरण करता है। चैनल बदलने से GitHub शाखा बदलती है।',
        hu: 'A Stable a main ágat követi (éles kiadások). A Development a dev ágat (folyamatban lévő munka). A csatornaváltás megváltoztatja, melyik GitHub-ág frissítéseit tölti le.',
        id: 'Stable mengikuti cabang main (rilis produksi). Development mengikuti cabang dev (pekerjaan terbaru). Mengganti saluran mengubah cabang GitHub sumber pembaruan.',
        it: 'Stable segue il branch main (release di produzione). Development segue il branch dev (lavoro in corso). Cambiare canale modifica il branch GitHub da cui arrivano gli aggiornamenti.',
        ja: 'Stable は main ブランチ（本番リリース）を追跡します。Development は dev ブランチ（開発中の最新版）を追跡します。チャンネル変更は更新取得元の GitHub ブランチを変えます。',
        ko: 'Stable은 main 브랜치(프로덕션 릴리스)를 추적합니다. Development는 dev 브랜치(진행 중인 작업)를 추적합니다. 채널 변경 시 GitHub 브랜치가 바뀝니다.',
        nb: 'Stable følger main-grenen (produksjonsutgivelser). Development følger dev-grenen (pågående arbeid). Kanalbytte endrer hvilken GitHub-gren oppdateringer hentes fra.',
        nl: 'Stable volgt de main-branch (productiereleases). Development volgt de dev-branch (lopend werk). Het wijzigen van het kanaal bepaalt van welke GitHub-branch updates komen.',
        pl: 'Stable śledzi gałąź main (wydania produkcyjne). Development śledzi gałąź dev (bieżąca praca). Zmiana kanału wpływa na to, z której gałęzi GitHub pobierane są aktualizacje.',
        pt: 'Stable segue o branch main (releases de produção). Development segue o branch dev (trabalho em curso). Alterar o canal muda o branch GitHub usado nas atualizações.',
        ro: 'Stable urmărește ramura main (release-uri de producție). Development urmărește ramura dev (lucru în curs). Schimbarea canalului modifică ramura GitHub pentru actualizări.',
        sv: 'Stable följer main-grenen (produktionsreleaser). Development följer dev-grenen (pågående arbete). Byte av kanal ändrar vilken GitHub-gren uppdateringar hämtas från.',
        th: 'Stable ติดตามสาขา main (รุ่นโปรดักชัน) Development ติดตามสาขา dev (งานล่าสุด) การเปลี่ยนช่องจะเปลี่ยนสาขา GitHub ที่ดึงอัปเดต',
        tr: 'Stable main dalını (üretim sürümleri) izler. Development dev dalını (devam eden çalışma) izler. Kanal değişikliği güncellemelerin çekildiği GitHub dalını değiştirir.',
        uk: 'Stable стежить за гілкою main (продакшн-релізи). Development — за гілкою dev (поточна розробка). Зміна каналу змінює гілку GitHub для оновлень.',
        vi: 'Stable theo dõi nhánh main (bản phát hành production). Development theo dõi nhánh dev (công việc đang tiến hành). Đổi kênh sẽ đổi nhánh GitHub lấy bản cập nhật.',
        zh: 'Stable 跟踪 main 分支（生产发布）。Development 跟踪 dev 分支（进行中的最新工作）。更改通道会影响从哪个 GitHub 分支拉取更新。',
        'zh-TW': 'Stable 追蹤 main 分支（正式發布）。Development 追蹤 dev 分支（進行中的最新工作）。變更通道會影響從哪個 GitHub 分支拉取更新。'
    },
    channel_stable: {
        ar: 'مستقر (main)', cs: 'Stabilní (main)', da: 'Stable (main)', de: 'Stable (main)',
        en: 'Stable (main)', es: 'Stable (main)', fi: 'Stable (main)', fr: 'Stable (main)',
        hi: 'Stable (main)', hu: 'Stable (main)', id: 'Stable (main)', it: 'Stable (main)',
        ja: 'Stable (main)', ko: 'Stable (main)', nb: 'Stable (main)', nl: 'Stable (main)',
        pl: 'Stable (main)', pt: 'Stable (main)', ro: 'Stable (main)', sv: 'Stable (main)',
        th: 'Stable (main)', tr: 'Stable (main)', uk: 'Stable (main)', vi: 'Stable (main)',
        zh: 'Stable (main)', 'zh-TW': 'Stable (main)'
    },
    channel_development: {
        ar: 'تطوير (dev)', cs: 'Vývoj (dev)', da: 'Development (dev)', de: 'Development (dev)',
        en: 'Development (dev)', es: 'Development (dev)', fi: 'Development (dev)', fr: 'Development (dev)',
        hi: 'Development (dev)', hu: 'Development (dev)', id: 'Development (dev)', it: 'Development (dev)',
        ja: 'Development (dev)', ko: 'Development (dev)', nb: 'Development (dev)', nl: 'Development (dev)',
        pl: 'Development (dev)', pt: 'Development (dev)', ro: 'Development (dev)', sv: 'Development (dev)',
        th: 'Development (dev)', tr: 'Development (dev)', uk: 'Development (dev)', vi: 'Development (dev)',
        zh: 'Development (dev)', 'zh-TW': 'Development (dev)'
    },
    channel_branch_label: {
        ar: 'فرع GitHub', cs: 'Větev GitHub', da: 'GitHub-gren', de: 'GitHub-Branch',
        en: 'GitHub branch', es: 'Rama de GitHub', fi: 'GitHub-haara', fr: 'Branche GitHub',
        hi: 'GitHub शाखा', hu: 'GitHub-ág', id: 'Cabang GitHub', it: 'Branch GitHub',
        ja: 'GitHub ブランチ', ko: 'GitHub 브랜치', nb: 'GitHub-gren', nl: 'GitHub-branch',
        pl: 'Gałąź GitHub', pt: 'Branch GitHub', ro: 'Ramură GitHub', sv: 'GitHub-gren',
        th: 'สาขา GitHub', tr: 'GitHub dalı', uk: 'Гілка GitHub', vi: 'Nhánh GitHub',
        zh: 'GitHub 分支', 'zh-TW': 'GitHub 分支'
    },
    channel_save: {
        ar: 'تطبيق القناة', cs: 'Použít kanál', da: 'Anvend kanal', de: 'Kanal anwenden',
        en: 'Apply channel', es: 'Aplicar canal', fi: 'Käytä kanavaa', fr: 'Appliquer le canal',
        hi: 'चैनल लागू करें', hu: 'Csatorna alkalmazása', id: 'Terapkan saluran', it: 'Applica canale',
        ja: 'チャンネルを適用', ko: '채널 적용', nb: 'Bruk kanal', nl: 'Kanaal toepassen',
        pl: 'Zastosuj kanał', pt: 'Aplicar canal', ro: 'Aplică canalul', sv: 'Tillämpa kanal',
        th: 'ใช้ช่องทาง', tr: 'Kanalı uygula', uk: 'Застосувати канал', vi: 'Áp dụng kênh',
        zh: '应用通道', 'zh-TW': '套用通道'
    },
    channel_saved: {
        ar: 'تم حفظ قناة التحديث. تحقق من التحديثات لمقارنة الفرع الجديد.',
        cs: 'Kanál aktualizací uložen. Zkontrolujte aktualizace vůči nové větvi.',
        da: 'Opdateringskanal gemt. Tjek for opdateringer mod den nye gren.',
        de: 'Update-Kanal gespeichert. Prüfen Sie Updates gegen den neuen Branch.',
        en: 'Update channel saved. Check for updates to compare against the new branch.',
        es: 'Canal de actualización guardado. Compruebe actualizaciones con la nueva rama.',
        fi: 'Päivityskanava tallennettu. Tarkista päivitykset uutta haaraa vasten.',
        fr: 'Canal de mise à jour enregistré. Vérifiez les mises à jour avec la nouvelle branche.',
        hi: 'अपडेट चैनल सहेजा गया। नई शाखा के लिए अपडेट जांचें।',
        hu: 'Frissítési csatorna mentve. Ellenőrizze a frissítéseket az új ághoz.',
        id: 'Saluran pembaruan disimpan. Periksa pembaruan terhadap cabang baru.',
        it: 'Canale aggiornamenti salvato. Controlla gli aggiornamenti con il nuovo branch.',
        ja: '更新チャンネルを保存しました。新しいブランチで更新を確認してください。',
        ko: '업데이트 채널이 저장되었습니다. 새 브랜치로 업데이트를 확인하세요.',
        nb: 'Oppdateringskanal lagret. Sjekk oppdateringer mot ny gren.',
        nl: 'Updatekanaal opgeslagen. Controleer updates tegen de nieuwe branch.',
        pl: 'Kanał aktualizacji zapisany. Sprawdź aktualizacje względem nowej gałęzi.',
        pt: 'Canal de atualização guardado. Verifique atualizações com o novo branch.',
        ro: 'Canal de actualizare salvat. Verificați actualizările față de noua ramură.',
        sv: 'Uppdateringskanal sparad. Kontrollera uppdateringar mot nya grenen.',
        th: 'บันทึกช่องทางอัปเดตแล้ว ตรวจสอบอัปเดตกับสาขาใหม่',
        tr: 'Güncelleme kanalı kaydedildi. Yeni dal için güncellemeleri kontrol edin.',
        uk: 'Канал оновлень збережено. Перевірте оновлення для нової гілки.',
        vi: 'Đã lưu kênh cập nhật. Kiểm tra cập nhật với nhánh mới.',
        zh: '更新通道已保存。请检查更新以对比新分支。',
        'zh-TW': '更新通道已儲存。請檢查更新以比對新分支。'
    },
    channel_save_failed: {
        ar: 'فشل حفظ قناة التحديث', cs: 'Nepodařilo se uložit kanál aktualizací',
        da: 'Kunne ikke gemme opdateringskanal', de: 'Update-Kanal konnte nicht gespeichert werden',
        en: 'Failed to save update channel', es: 'No se pudo guardar el canal de actualización',
        fi: 'Päivityskanavan tallennus epäonnistui', fr: 'Échec de l’enregistrement du canal',
        hi: 'अपडेट चैनल सहेजना विफल', hu: 'A frissítési csatorna mentése sikertelen',
        id: 'Gagal menyimpan saluran pembaruan', it: 'Impossibile salvare il canale aggiornamenti',
        ja: '更新チャンネルの保存に失敗しました', ko: '업데이트 채널 저장 실패',
        nb: 'Kunne ikke lagre oppdateringskanal', nl: 'Updatekanaal opslaan mislukt',
        pl: 'Nie udało się zapisać kanału aktualizacji', pt: 'Falha ao guardar canal de atualização',
        ro: 'Salvarea canalului de actualizare a eșuat', sv: 'Kunde inte spara uppdateringskanal',
        th: 'บันทึกช่องทางอัปเดตไม่สำเร็จ', tr: 'Güncelleme kanalı kaydedilemedi',
        uk: 'Не вдалося зберегти канал оновлень', vi: 'Không thể lưu kênh cập nhật',
        zh: '保存更新通道失败', 'zh-TW': '儲存更新通道失敗'
    },
    channel_switch_warning: {
        ar: 'تغيير قناة التحديث يغيّر فرع GitHub المستخدم للفحص والتثبيت. يُحتفظ بـ SHA للالتزام المتتبع — قد يظهر الفحص التالي فرقًا كبيرًا. المتابعة؟',
        cs: 'Změna kanálu mění větev GitHub pro kontroly a instalace. Sledované SHA commitu zůstává — další kontrola může ukázat velký rozdíl. Pokračovat?',
        da: 'Skift af opdateringskanal ændrer hvilken GitHub-gren der bruges. Sporet commit-SHA beholdes — næste tjek kan vise stor forskel. Fortsæt?',
        de: 'Ein Kanalwechsel ändert den GitHub-Branch für Prüfung und Installation. Die verfolgte Commit-SHA bleibt — der nächste Check kann eine große Differenz zeigen. Fortfahren?',
        en: 'Switching the update channel changes which GitHub branch is used for version checks and installs. Your tracked commit SHA is kept — the next check may show a large diff. Continue?',
        es: 'Cambiar el canal modifica la rama GitHub usada. Se conserva el SHA rastreado — la próxima comprobación puede mostrar una gran diferencia. ¿Continuar?',
        fi: 'Kanavan vaihto muuttaa GitHub-haaraa. Seurattu commit-SHA säilyy — seuraava tarkistus voi näyttää suuren eron. Jatketaanko?',
        fr: 'Changer de canal modifie la branche GitHub utilisée. Le SHA suivi est conservé — la prochaine vérification peut montrer un grand écart. Continuer ?',
        hi: 'चैनल बदलने से GitHub शाखा बदलेगी। ट्रैक किया SHA रहेगा — अगली जांच में बड़ा अंतर दिख सकता है। जारी रखें?',
        hu: 'A csatornaváltás megváltoztatja a GitHub-ágat. A követett commit SHA megmarad — a következő ellenőrzés nagy különbséget mutathat. Folytatja?',
        id: 'Mengganti saluran mengubah cabang GitHub. SHA commit yang dilacak tetap — pemeriksaan berikutnya bisa menunjukkan perbedaan besar. Lanjutkan?',
        it: 'Cambiare canale modifica il branch GitHub usato. Lo SHA tracciato resta — il prossimo controllo può mostrare una grande differenza. Continuare?',
        ja: 'チャンネル変更は GitHub ブランチを変えます。追跡中の commit SHA は保持されます — 次回チェックで大きな差分が出る場合があります。続行しますか？',
        ko: '채널 변경 시 GitHub 브랜치가 바뀝니다. 추적 중인 commit SHA는 유지됩니다 — 다음 확인에서 큰 차이가 보일 수 있습니다. 계속할까요?',
        nb: 'Kanalbytte endrer GitHub-gren. Sporet commit-SHA beholdes — neste sjekk kan vise stor forskjell. Fortsette?',
        nl: 'Kanaalwijziging verandert de GitHub-branch. Bijgehouden commit-SHA blijft — volgende check kan groot verschil tonen. Doorgaan?',
        pl: 'Zmiana kanału zmienia gałąź GitHub. Śledzone SHA commita zostaje — następne sprawdzenie może pokazać dużą różnicę. Kontynuować?',
        pt: 'Alterar o canal muda o branch GitHub. O SHA rastreado mantém-se — a próxima verificação pode mostrar grande diferença. Continuar?',
        ro: 'Schimbarea canalului modifică ramura GitHub. SHA-ul urmărit rămâne — următoarea verificare poate arăta diferență mare. Continuați?',
        sv: 'Kanalbyte ändrar GitHub-gren. Spårat commit-SHA behålls — nästa kontroll kan visa stor skillnad. Fortsätta?',
        th: 'การเปลี่ยนช่องจะเปลี่ยนสาขา GitHub SHA ที่ติดตามยังอยู่ — การตรวจครั้งถัดไปอาจแสดงความต่างมาก ดำเนินการต่อ?',
        tr: 'Kanal değişikliği GitHub dalını değiştirir. İzlenen commit SHA korunur — sonraki kontrol büyük fark gösterebilir. Devam?',
        uk: 'Зміна каналу змінює гілку GitHub. Відстежуваний SHA commit залишається — наступна перевірка може показати велику різницю. Продовжити?',
        vi: 'Đổi kênh sẽ đổi nhánh GitHub. SHA commit theo dõi được giữ — lần kiểm tra sau có thể hiện chênh lệch lớn. Tiếp tục?',
        zh: '更改通道会改变 GitHub 分支。已跟踪的 commit SHA 会保留 — 下次检查可能显示较大差异。继续？',
        'zh-TW': '變更通道會改變 GitHub 分支。已追蹤的 commit SHA 會保留 — 下次檢查可能顯示較大差異。繼續？'
    }
};

const files = fs.readdirSync(LANG_DIR).filter((f) => f.endsWith('.json'));

for (const file of files) {
    const locale = file.replace(/\.json$/, '');
    const fullPath = path.join(LANG_DIR, file);
    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    if (!data.updates) {
        console.warn('Skip (no updates section):', file);
        continue;
    }
    for (const [key, map] of Object.entries(KEYS)) {
        data.updates[key] = map[locale] || map.en;
    }
    fs.writeFileSync(fullPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    console.log('Patched', file);
}
