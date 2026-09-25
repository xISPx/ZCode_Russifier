#!/usr/bin/env node
/**
 * ZCode Russifier — adds a Russian UI to ZCode Desktop (Windows) by patching app.asar.
 *
 * How it works: the app ships exactly two UI locales (en-US / zh-CN). The en-US
 * string catalogs (renderer, native menu, main-process dialogs) are rewritten
 * in place with Russian translations from ./translations. Untouched files keep
 * their byte offsets, so a running instance keeps working until restart.
 *
 * Usage:   node russify.js [path-to-ZCode-install-dir]
 * Default install dir: %LOCALAPPDATA%\Programs\ZCode
 * Rollback: reinstall or update ZCode — the updater restores the stock app.asar.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const installDir = path.resolve(
  process.argv[2] ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'ZCode')
);
const RES = path.join(installDir, 'resources');
const ASAR = path.join(RES, 'app.asar');
const TRANSL_DIR = path.join(__dirname, 'translations');

if (!fs.existsSync(ASAR)) {
  console.error('Не найден ' + ASAR);
  console.error('Укажите путь установки: node russify.js "C:\\путь\\к\\ZCode"');
  process.exit(1);
}

// ---------- load translations ----------
// works both from the repo layout (translations/) and from a flat
// self-extracting package where the dictionaries sit next to the script
let translDir = path.join(__dirname, 'translations');
if (!fs.existsSync(translDir)) translDir = __dirname;
const translations = {};
for (const f of fs.readdirSync(translDir).filter((n) => /^ru-.*\.json$/.test(n)).sort()) {
  Object.assign(translations, JSON.parse(fs.readFileSync(path.join(translDir, f), 'utf8')));
}

// ---------- read asar ----------
const fd = fs.openSync(ASAR, 'r');
const sizeBuf = Buffer.alloc(16);
fs.readSync(fd, sizeBuf, 0, 16, 0);
if (sizeBuf.readUInt32LE(0) !== 4 || sizeBuf.readUInt32LE(8) !== sizeBuf.readUInt32LE(4) - 4) {
  console.error('Неожиданный формат asar-заголовка; прерывание.');
  process.exit(1);
}
const headerPickleSize = sizeBuf.readUInt32LE(4);
const contentStart = 8 + headerPickleSize;
const jsonLenOrig = sizeBuf.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLenOrig);
fs.readSync(fd, jsonBuf, 0, jsonLenOrig, 16);
const header = JSON.parse(jsonBuf.toString());
const fileSize = fs.fstatSync(fd).size;

function getEntry(relPath) {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) throw new Error('bad path');
  let node = header;
  for (const p of parts) {
    if (!node.files || !node.files[p]) return null;
    node = node.files[p];
  }
  return node && node.offset !== undefined ? node : null;
}
function readFile(relPath) {
  const e = getEntry(relPath);
  if (!e) throw new Error('нет в архиве: ' + relPath);
  const buf = Buffer.alloc(e.size);
  fs.readSync(fd, buf, 0, e.size, contentStart + parseInt(e.offset, 10));
  return buf;
}

// integrity replication (SHA-256 of whole file + 4 MiB blocks), self-tested
const BLOCK = 4194304;
function integrityOf(buf) {
  const blocks = [];
  for (let off = 0; off < buf.length; off += BLOCK) {
    blocks.push(crypto.createHash('sha256').update(buf.subarray(off, Math.min(off + BLOCK, buf.length))).digest('hex'));
  }
  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(buf).digest('hex'),
    blockSize: BLOCK,
    blocks: blocks,
  };
}
{
  const stored = getEntry('/package.json').integrity;
  const mine = integrityOf(readFile('/package.json'));
  if (mine.hash !== stored.hash) {
    console.error('Контрольные суммы не совпали — неизвестная структура asar; прерывание.');
    process.exit(1);
  }
}

// ---------- discover target chunks ----------
let intlChunk = null;
const mainCandidates = [];
(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name;
    if (child.files) walk(child, p);
    else if (p.startsWith('/out/renderer/assets/') && /^IntlProvider-.*\.js$/.test(name)) intlChunk = p;
    else if (p.startsWith('/out/main/') && name.endsWith('.js')) mainCandidates.push(p);
  }
})(header, '');
if (!intlChunk) { console.error('Не найден чанк IntlProvider (структура приложения изменилась?).'); process.exit(1); }
let menuChunk = null;
for (const c of mainCandidates) {
  if (readFile(c).includes('"tray.menu.quit"')) { menuChunk = c; break; }
}
if (!menuChunk) { console.error('Не найден чанк нативного меню.'); process.exit(1); }
const mainChunk = '/out/main/index.js';
console.log('Чанки: ' + intlChunk + ', ' + menuChunk + ', ' + mainChunk);

// ---------- renderer catalog ----------
const catSrc = readFile(intlChunk).toString('utf8');
// locate the locale map  g={"zh-CN":p,"en-US":m}  and resolve the en-US catalog variable
const gMap = catSrc.match(/=\{"zh-CN":[A-Za-z0-9_$]+,"en-US":([A-Za-z0-9_$]+)\}/);
if (!gMap) { console.error('Не найден каталог локалей в рендерере.'); process.exit(1); }
const enName = gMap[1];
const assignIdx = catSrc.lastIndexOf(enName + '={', gMap.index);
if (assignIdx === -1 || !',;( '.includes(catSrc[assignIdx - 1])) {
  console.error('Не найден объект каталога en-US.'); process.exit(1);
}
function findObjEnd(text, openIdx) {
  let depth = 0, i = openIdx, inTpl = false, inStr = false, strCh = '';
  for (; i < text.length; i++) {
    const c = text[i];
    if (inTpl) { if (c === '\\') i++; else if (c === '`') inTpl = false; }
    else if (inStr) { if (c === '\\') i++; else if (c === strCh) inStr = false; }
    else {
      if (c === '`') inTpl = true;
      else if (c === '"' || c === "'") { inStr = true; strCh = c; }
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i; }
    }
  }
  return -1;
}
const openIdx = assignIdx + enName.length + 1; // the '{' of the en-US catalog object
const closeIdx = findObjEnd(catSrc, openIdx);
if (closeIdx === -1) { console.error('Не удалось определить границы каталога.'); process.exit(1); }
const mObjText = catSrc.slice(openIdx + 1, closeIdx);
const entryRe = /"([^"]+)":`([\s\S]*?)`(?=[,\}]|$)/g;
const enValues = {};
for (const m of mObjText.matchAll(entryRe)) enValues[m[1]] = m[2];

function tokens(s) { return (s.match(/\{[A-Za-z0-9_.]+\}/g) || []).sort().join(','); }
let applied = 0;
const newM = {};
for (const [k, v] of Object.entries(enValues)) {
  const ru = translations[k];
  newM[k] = ru !== undefined && tokens(ru) === tokens(v) ? ru : v;
  if (newM[k] === ru) applied++;
}
const rebuilt = Object.entries(newM).map(([k, v]) => '"' + k + '":`' + v + '`').join(',');
{
  let count = 0;
  for (const m of rebuilt.matchAll(entryRe)) count++;
  if (count !== Object.keys(enValues).length || count < 100) { console.error('Пересборка каталога теряет ключи; прерывание.'); process.exit(1); }
}
const newIntlSrc = catSrc.slice(0, openIdx + 1) + rebuilt + catSrc.slice(closeIdx);
console.log('Каталог интерфейса: переведено ' + applied + ' из ' + Object.keys(enValues).length + ' строк');

// ---------- native menu ----------
function translateQuotedMap(srcText, dict) {
  const start = srcText.indexOf('"en-US":{');
  if (start === -1) return { text: srcText, translated: 0, total: 0 };
  let i = start + '"en-US":'.length, depth = 0, end = -1, inStr = false, esc = false;
  for (; i < srcText.length; i++) {
    const c = srcText[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return { text: srcText, translated: 0, total: 0 };
  const region = srcText.slice(start, end + 1);
  const pairRe = /"([A-Za-z0-9._]+)":"((?:[^"\\]|\\.)*)"/g;
  let translated = 0;
  const newRegion = region.replace(pairRe, (full, key) => {
    if (Object.prototype.hasOwnProperty.call(dict, key)) { translated++; return '"' + key + '":"' + dict[key] + '"'; }
    return full;
  });
  return { text: srcText.slice(0, start) + newRegion + srcText.slice(end + 1), translated: translated, total: (region.match(pairRe) || []).length };
}
const menuSrc = readFile(menuChunk).toString('utf8');
const menuRes = translateQuotedMap(menuSrc, translations);
console.log('Нативное меню: переведено ' + menuRes.translated + ' из ' + menuRes.total + ' пунктов');

// ---------- automation/offPeak templates (server-side {cn,en} pairs, rendered via m4) ----------
let stylesChunk = null;
(function walkStyles(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name;
    if (child.files) walkStyles(child, p);
    else if (p.startsWith('/out/renderer/assets/') && /^styles-.*\.js$/.test(name)) stylesChunk = p;
  }
})(header, '');
let stylesText = readFile(stylesChunk).toString('utf8');
const M4_FIND = 'function m4(e,t){let n=t?.startsWith(`zh`)??!1,r=n?e.cn:e.en,i=n?e.en:e.cn;return r?.trim()||i?.trim()||``}';
const M4_REP = `function m4(e,t){let n=t?.startsWith(\`zh\`)??!1,r=n?e.cn:e.en,i=n?e.en:e.cn;if(!n&&r){let _x=r.trim();if(_x){let _m={"Standup Git Summary":"Сводка Git для стендапа","CI Failures & Flaky Test Report":"Отчёт по падениям CI и нестабильным тестам","Documentation sync check":"Проверка актуальности документации","Morning dev brief":"Утренняя сводка разработчику","Risk scan":"Скан рисков","Release brief":"Релизная сводка"};if(_m[_x])return _m[_x];let _p=[["Summarize this week's git activity into a Friday standup","Соберёт git-активность недели к пятничному стендапу: ключевые коммиты, влитые PR и что изменилось — коротко и по делу."],["Scan recent CI runs, list failing and flaky tests","Просмотрит недавние прогоны CI, перечислит упавшие и нестабильные тесты с вероятными причинами и предложит исправления по важности."],["Using the current implementation and recent commits as evidence","Сверит README, документацию и конфигурации с фактическим кодом и свежими коммитами, отметит расхождения."],["Summarize commits, module changes, CI status, and follow-ups since the previous workday","Резюмирует коммиты, изменения модулей, статус CI и незакрытые вопросы с прошлого рабочего дня — в заданный лимит объёма."],["Inspect code changes from the last 24 hours for high-confidence risks","Изучит изменения кода за последние 24 часа и найдёт риски: сбои рантайма, потерю данных, проблемы безопасности."],["Organize PRs and commits merged this week","Разложит PR и коммиты недели по разделам: фичи, исправления, улучшения опыта и инженерия."],["Compare code, configuration, API, and documentation changes from the last seven days","Сравнит изменения кода, конфигураций, API и документации за семь дней и подсветит расхождения."]];for(let _z of _p){if(_x.startsWith(_z[0]))return _z[1]}}}return r?.trim()||i?.trim()||\`\`}`;
{
  // the helper's name and locals change between builds (m4, e4, ...) — match by shape
  const m4re = /function ([A-Za-z0-9_$]+)\(e,t\)\{let ([A-Za-z0-9_$]+)=t\?\.startsWith\(`zh`\)\?\?!1,([A-Za-z0-9_$]+)=\2\?e\.cn:e\.en,([A-Za-z0-9_$]+)=\2\?e\.en:e\.cn;return \3\?\.trim\(\)\|\|\4\?\.trim\(\)\|\|``\}/;
  const parts = stylesText.split(M4_FIND);
  const m4m = parts.length === 2 ? null : stylesText.match(m4re);
  if (parts.length === 2) {
    stylesText = parts.join(M4_REP);
    console.log('Шаблоны автоматизаций: патч выбора языка m4 применён');
  } else if (m4m) {
    stylesText = stylesText.replace(m4m[0], () => M4_REP.replace('function m4(', 'function ' + m4m[1] + '('));
    console.log('Шаблоны автоматизаций: патч выбора языка (' + m4m[1] + ') применён');
  } else if (stylesText.includes('"Сводка Git для стендапа"')) {
    console.log('Шаблоны автоматизаций: m4 уже пропатчен');
  } else {
    console.log('Шаблоны автоматизаций: функция m4 не найдена — карточки шаблонов останутся английскими');
  }
}

// ---------- server-driven campaign popups (Entitlement Rules etc.) ----------
// The popup text comes from the Z.ai API already localized (zh-CN/en-US only);
// patch the marketing-touch store to map known English strings to Russian
// right after the deliveries query resolves.
const POPUP_FIND = 'let u=await e.query();if(n||l!==r)return;';
const POPUP_REP = 'let u=await e.query();try{let _m={"Entitlement Rules":"Правила применения квоты","When you use GLM through Coding Plan in ZCode, quota consumption is converted at a 0.67 coefficient throughout the campaign period.":"При использовании GLM через Coding Plan в ZCode расход квоты пересчитывается с коэффициентом 0,67 в течение всей акции.","In other words, the same model usage only deducts 67% from quota. Effectively, your available quota during the campaign is about 1.5x the original amount.":"Иначе говоря, за то же использование модели списывается только 67% квоты. Фактически доступная квота во время акции — примерно в 1,5 раза больше исходной.","The conversion rules and end time of the quota benefit is subject to the official announcement.":"Правила пересчёта и срок действия бонусной квоты определяются официальным анонсом.","Got it":"Понятно","I understand":"Я понимаю","Close":"Закрыть","OK":"ОК"};let _t=x=>{if(typeof x!==\'string\')return x;let _y=x.trim();return _m[_y]!==undefined?_m[_y]:x};u.deliveries=(u.deliveries||[]).map(d=>{if(d&&d.dialog){d.dialog.title=_t(d.dialog.title);if(d.dialog.description&&typeof d.dialog.description.text===\'string\'){d.dialog.description.text=d.dialog.description.text.split(/\\n\\n+/).map(p=>_t(p)).join(\'\\n\\n\')}if(Array.isArray(d.dialog.buttons))d.dialog.buttons.forEach(b=>{if(b)b.label=_t(b.label)})}return d})}catch{}if(n||l!==r)return;';
{
  const parts = stylesText.split(POPUP_FIND);
  if (parts.length === 2) {
    stylesText = parts.join(POPUP_REP);
    console.log('Серверные попапы (акции): перехват перевода применён');
  } else if (stylesText.includes('"Правила применения квоты"')) {
    console.log('Серверные попапы (акции): перехват уже применён');
  } else {
    console.log('Серверные попапы (акции): точка перехвата не найдена — кампании останутся английскими');
  }
}

// ---------- main-process dialogs ----------
const DOLLAR = String.fromCharCode(36);
const mainReplacements = [
  ['?"\\u786E\\u5B9A":"OK"]', '?"\\u786E\\u5B9A":"ОК"]'],
  [':["Cancel","OK"]}', ':["Отмена","ОК"]}'],
  ['buttons:["Open folder","Cancel"],title:"Open external ZCode link?",message:"Open this folder in ZCode?"',
   'buttons:["Открыть папку","Отмена"],title:"Открыть внешнюю ссылку ZCode?",message:"Открыть эту папку в ZCode?"'],
  ['{text:"ZCode is controlling your computer",width:308}', '{text:"ZCode управляет компьютером",width:308}'],
  ['"No installable update was found. Use manual update instead."', '"Устанавливаемых обновлений не найдено. Используйте ручное обновление."'],
  ['aboutTitle:"About ZCode"', 'aboutTitle:"О ZCode"'],
  ['versionLabel:"version"', 'versionLabel:"версия"'],
  ['okButtonLabel:"OK"', 'okButtonLabel:"ОК"'],
  ['optimizedForAppleSilicon:"Optimized for Apple Silicon."', 'optimizedForAppleSilicon:"Оптимизировано для Apple Silicon."'],
  ['`Copyright \\xA9 ' + DOLLAR + '{e} ZCode.`', '`Все права защищены \\xA9 ' + DOLLAR + '{e} ZCode.`'],
  ['checkingTitle:"Checking for updates"', 'checkingTitle:"Проверка обновлений"'],
  ['checkingMessage:"Keep this window open while ZCode checks for updates."', 'checkingMessage:"Держите это окно открытым — ZCode ищет доступные обновления."'],
  ['downloadingTitle:"Downloading update"', 'downloadingTitle:"Скачивание обновления"'],
  ['downloadingVersionTitle:"Downloading update v{version}"', 'downloadingVersionTitle:"Скачивание обновления v{version}"'],
  ['downloadingMessage:"ZCode will install the update automatically after download."', 'downloadingMessage:"После загрузки обновление установится автоматически."'],
  ['readyTitle:"Update downloaded"', 'readyTitle:"Обновление загружено"'],
  ['readyMessage:"ZCode is preparing to restart and install the update."', 'readyMessage:"ZCode готовится перезапуститься и установить обновление."'],
  ['installingTitle:"Installing update"', 'installingTitle:"Установка обновления"'],
  ['installingMessage:"ZCode will restart to finish installing the update."', 'installingMessage:"ZCode перезапустится, чтобы завершить установку."'],
  ['errorTitle:"Auto update failed"', 'errorTitle:"Ошибка автообновления"'],
  ['errorMessage:"You can retry auto update or use manual update."', 'errorMessage:"Повторите автообновление или обновите вручную."'],
  ['devSkippedTitle:"Auto update unavailable in development"', 'devSkippedTitle:"Автообновление недоступно в dev-сборке"'],
  ['devSkippedMessage:"Auto update is only available in packaged apps. Use manual update or test a packaged build."', 'devSkippedMessage:"Автообновление работает только в собранных приложениях. Обновите вручную или соберите пакет."'],
  ['confirmCloseTitle:"Auto update in progress"', 'confirmCloseTitle:"Идёт автообновление"'],
  ['confirmCloseMessage:"Closing this window will stop the current auto update flow, and this old version still cannot open the main app. You can keep waiting or close and quit."', 'confirmCloseMessage:"Закрытие окна прервёт автообновление, и эта старая версия всё равно не сможет открыть приложение. Можно подождать или закрыть и выйти."'],
  ['confirmCloseButton:"Close anyway"', 'confirmCloseButton:"Всё равно закрыть"'],
  ['continueUpdateButton:"Continue update"', 'continueUpdateButton:"Продолжить обновление"'],
  ['retryButton:"Retry auto update"', 'retryButton:"Повторить автообновление"'],
  ['checkingButton:"Checking..."', 'checkingButton:"Проверка..."'],
  ['downloadingButton:"Downloading..."', 'downloadingButton:"Скачивание..."'],
  ['installingButton:"Installing..."', 'installingButton:"Установка..."'],
];
let mainText = readFile(mainChunk).toString('utf8');
let mainApplied = 0;
for (const pair of mainReplacements) {
  const find = pair[0];
  const rep = pair[1];
  const parts = mainText.split(find);
  if (parts.length !== 2) continue;
  mainText = parts.join(rep);
  mainApplied++;
}
console.log('Диалоги главного процесса: переведено ' + mainApplied + ' из ' + mainReplacements.length + ' заготовок');

// ---------- rebuild asar ----------
const changed = new Map([
  [intlChunk, Buffer.from(newIntlSrc, 'utf8')],
  [menuChunk, Buffer.from(menuRes.text, 'utf8')],
  [mainChunk, Buffer.from(mainText, 'utf8')],
  [stylesChunk, Buffer.from(stylesText, 'utf8')],
]);
const newEntries = [];
let appendOffset = fileSize - contentStart;
for (const [rel, buf] of changed) {
  newEntries.push({ e: getEntry(rel), size: buf.length, offset: String(appendOffset), integrity: integrityOf(buf), buf: buf });
  appendOffset += buf.length;
}
for (const n of newEntries) {
  n.e.size = n.size;
  n.e.offset = n.offset;
  n.e.integrity = n.integrity;
}
let headerJson = JSON.stringify(header);
// pad with spaces so the header region keeps its original byte length —
// then untouched files stay at their exact offsets and an in-place overwrite
// remains safe even while ZCode is running.
const headerBudget = headerPickleSize - 8; // 4-byte length prefix + json + padding
if (Buffer.byteLength(headerJson, 'utf8') > headerBudget) {
  console.error('Заголовок вырос — закройте ZCode и запустите скрипт ещё раз (нужна простая замена файла).');
  process.exit(1);
}
headerJson = headerJson.padEnd(headerBudget, ' ');
const jsonLen = Buffer.byteLength(headerJson, 'utf8');
const pad = 0; // jsonLen now equals headerBudget: 4 + jsonLen stays 4-aligned automatically
if ((4 + jsonLen) % 4 !== 0) {
  console.error('Не сошлось выравнивание заголовка; прерывание.');
  process.exit(1);
}
JSON.parse(headerJson); // sanity

const prefix = Buffer.alloc(16);
prefix.writeUInt32LE(4, 0);
prefix.writeUInt32LE(8 + jsonLen + pad, 4);
prefix.writeUInt32LE(4 + jsonLen + pad, 8);
prefix.writeUInt32LE(jsonLen, 12);

const tmpPath = ASAR + '.russified';
const out = fs.openSync(tmpPath, 'w');
fs.writeSync(out, prefix, 0, 16);
fs.writeSync(out, Buffer.from(headerJson, 'utf8'), 0, jsonLen);
if (pad) fs.writeSync(out, Buffer.alloc(pad), 0, pad);
{
  const CP = 8 * 1024 * 1024;
  const cpBuf = Buffer.alloc(CP);
  let pos = contentStart;
  while (pos < fileSize) {
    const n = fs.readSync(fd, cpBuf, 0, Math.min(CP, fileSize - pos), pos);
    fs.writeSync(out, cpBuf, 0, n);
    pos += n;
  }
}
for (const n of newEntries) fs.writeSync(out, n.buf, 0, n.buf.length);
fs.closeSync(out);
fs.closeSync(fd);

// ---------- apply ----------
try {
  fs.renameSync(tmpPath, ASAR);
  console.log('Готово: патченный архив подменён. Перезапустите ZCode (если он был запущен).');
} catch (e) {
  // app is running and holds the file — overwrite in place (layout is offset-compatible)
  const t = fs.openSync(tmpPath, 'r');
  const target = fs.openSync(ASAR, 'r+');
  const size = fs.fstatSync(t).size;
  const CP = 8 * 1024 * 1024;
  const buf = Buffer.alloc(CP);
  let pos = 0;
  while (pos < size) {
    const n = fs.readSync(t, buf, 0, Math.min(CP, size - pos), pos);
    fs.writeSync(target, buf, 0, n, pos);
    pos += n;
  }
  fs.closeSync(t);
  fs.closeSync(target);
  fs.unlinkSync(tmpPath);
  console.log('Готово: архив перезаписан поверх (приложение было запущено). Перезапустите ZCode.');
}
console.log('Откат: просто обновите или переустановите ZCode — установщик вернёт оригинальный архив.');
console.log('После каждого обновления ZCode запускайте скрипт снова.');
