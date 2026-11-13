/*
 * Тесты страницы «Проверка запроса»: разные форматы, в которых присылают запросы
 * (curl, fetch, Python, PowerShell, сырой HTTP, логи Go/PHP/JSON, сообщения из чатов).
 * Для каждого проверяется, какой эндпоинт найден, какой вердикт и ключевые строки отчёта.
 * Данные в примерах вымышленные.
 * Запуск: SUPPORT_PW=… NODE_PATH=$(npm root -g) node tests/check.test.js
 */
const path = require("path");
const { chromium } = require("playwright");

const URL = "file://" + path.join(__dirname, "..", "index.html");
const UUID = "11111111-2222-4333-8444-555555555555";
const TOKEN_BODY = `{"api_key":"testkey0000","b2b_id":"${UUID}"}`;

/* exp: op — «METHOD path» найденного эндпоинта (null — не найден);
        level — ok | warn | err; has — подстроки отчёта; not — чего в отчёте быть не должно */
const CASES = [
  { name: "curl (bash)", exp: { op: "POST /api/v1/b2b/token", level: "ok" },
    text: `curl -X POST 'https://transaction.uat.agg.bet/api/v1/b2b/token' -H 'Content-Type: application/json' -d '${TOKEN_BODY}'` },
  { name: "curl (Windows cmd, ^ и \\\")", exp: { op: "POST /api/v1/b2b/token", level: "ok" },
    text: `curl -X POST "https://transaction.uat.agg.bet/api/v1/b2b/token" ^\n  -H "Content-Type: application/json" ^\n  -d "${TOKEN_BODY.replace(/"/g, '\\"')}"` },
  { name: "curl из Chrome ($'…')", exp: { op: "POST /api/v1/b2b/token", level: "ok" },
    text: `curl 'https://transaction.uat.agg.bet/api/v1/b2b/token' -H 'content-type: application/json' --data-raw $'${TOKEN_BODY}' --compressed` },
  { name: "Copy as fetch", exp: { op: "POST /api/v1/b2b/token", level: "ok", has: ["fetch()"] },
    text: `fetch("https://transaction.uat.agg.bet/api/v1/b2b/token", {\n  "headers": {"content-type": "application/json"},\n  "body": ${JSON.stringify(TOKEN_BODY)},\n  "method": "POST"\n});` },
  { name: "Python requests", exp: { op: "POST /api/v1/b2b/token", level: "ok", has: ["Python"] },
    text: `import requests\nr = requests.post("https://transaction.uat.agg.bet/api/v1/b2b/token", json={"api_key": "testkey0000", "b2b_id": "${UUID}"})` },
  { name: "PowerShell", exp: { op: "POST /api/v1/b2b/token", level: "ok", has: ["PowerShell"] },
    text: `Invoke-RestMethod -Uri "https://transaction.uat.agg.bet/api/v1/b2b/token" -Method Post -ContentType "application/json" -Body '${TOKEN_BODY}'` },
  { name: "JSON-лог запроса", exp: { op: "POST /api/v1/b2b/token", level: "ok" },
    text: JSON.stringify({ method: "POST", url: "https://transaction.uat.agg.bet/api/v1/b2b/token", headers: { "Content-Type": "application/json" }, body: JSON.parse(TOKEN_BODY) }) },
  { name: "Сырой HTTP + ответ HTTP/1.1 401", exp: { op: "POST /api/v1/b2b/token", level: "err", has: ["собран из пути и заголовка Host", "b2b apikey is invalid"] },
    text: `POST /api/v1/b2b/token HTTP/1.1\nHost: transaction.uat.agg.bet\nContent-Type: application/json\nContent-Length: 80\n\n${TOKEN_BODY}\n\nHTTP/1.1 401 Unauthorized\nContent-Type: application/json\n\n{"error":"b2b apikey is invalid"}` },
  { name: "curl и сразу JSON ответа (без «Ответ:»)", exp: { op: "POST /api/v1/b2b/token", has: ["b2b apikey is invalid"] },
    text: `curl -X POST 'https://transaction.uat.agg.bet/api/v1/b2b/token' -H 'Content-Type: application/json' -d '${TOKEN_BODY}'\n{"error":"b2b apikey is invalid"}` },
  { name: "Go-лог + status_code=400 response=", exp: { op: "POST /api/v1/b2b/token", has: ["лог Go-сервиса", "HTTP 400"] },
    text: `method=POST url=https://transaction.uat.agg.bet/api/v1/b2b/token\nHeaders:map[Content-Type:application/json] Body:map[api_key:testkey0000 b2b_id:${UUID}]\nОтвет: status_code=400 response={“error”:“b2b apikey is invalid”}` },
  { name: "PHP-лог без URL (Round Check)", exp: { op: "POST /api/v1/b2b/reports/round-check", has: ["лог PHP", "подобран по полям тела", "Internal error"] },
    text: `Data: array (\n 'round_id' => 'abc123',\n 'b2c_id' => '42',\n 'game_id' => '${UUID}',\n)\nHeader:\narray (\n 0 => 'Content-Type: application/json',\n 1 => 'b2b-client-id: ${UUID}',\n)\nResponse:\narray (\n 'error' => 'Internal error',\n)` },
  { name: "Сообщение из Slack: «умные» кавычки, обрезанный URL, ответ", exp: { op: "POST /api/v1/b2b/deposit", level: "err", has: ["Типографские кавычки", "обрезан", "connection not found", "Winfinity"] },
    text: `[10.11.2026 12:58] Partner: for deposit api:\ncurl --location ‘https://proxy.example.net/api/…/deposit’ \\\n--header ‘b2b-client-id: ${UUID}’ \\\n--header ‘vendor-id: 8f3d22d6-591f-11ed-9b6a-0242ac120002’ \\\n--header ‘Content-Type: application/json’ \\\n--data ‘{\n “b2c_id”: “1”,\n “transaction_id”: “${UUID}”,\n “currency”: “THB”,\n “amount”: “100.00”\n}’\n[10.11.2026 12:58] Partner: get this response: {\n “error”: “b2b ID=\\“x\\“, vendor ID=\\“8f3d22d6-591f-11ed-9b6a-0242ac120002\\“: connection not found”\n}` },
  { name: "Только ответ, без запроса", exp: { op: null, has: ["проверен только ответ", "connection not found"] },
    text: `Ответ:\n{"error": "b2b ID=\\"x\\", vendor ID=\\"y\\": connection not found"}` },
  { name: "Callback на адрес партнёра — подбор по телу", exp: { op: "POST /<path-for-bet-win>", has: ["похоже на callback"] },
    text: `POST https://partner.example.com/callback/bet\nContent-Type: application/json\n\n{"b2b_session_id":"x","b2c_id":"1","game_id":"g","round_id":"r","transaction_id":"t","amount":1,"currency":"USD","hash":"h"}` },
  { name: "Winfinity: команда выбирается по com", exp: { op: "POST /api/v1/vendor/command", has: ["Win (com 2)", "выбран по телу"] },
    text: `curl -X POST 'https://8f3d22d6591f11ed9b6a0242ac120002.transaction.uat.agg.bet/api/v1/vendor/command' -H 'Content-Type: application/json' -d '{"com":2,"tid":"a","msid":"b","tbid":"c","uid":"d","cur":"USD","gtp":"Roulette","sid":"e","gid":"f","refid":"r","sum":10,"timestamp":1694505755000000}'` },
  { name: "Mancala Provider: Debit без vendor-префикса хоста", exp: { op: "POST /api/v1/vendor/Debit", level: "err", has: ["vendor-хост"] },
    text: `POST https://transaction.uat.agg.bet/api/v1/vendor/Debit\nContent-Type: application/json\n\n{"SessionId":"s","RoundGuid":"r","TransactionGuid":"t","Amount":5,"DebitType":2,"Hash":"x","BonusTransaction":false,"ExternalBonusId":""}` },
  { name: "Неизвестный путь → подсказка похожих", exp: { op: null, level: "err", has: ["не найден", "Похожие эндпоинты"] },
    text: `GET https://transaction.uat.agg.bet/api/v1/b2b/games\nb2b-client-id: ${UUID}` },
  { name: "Ошибки в теле: тип, enum, лишняя запятая", exp: { op: "POST /api/v1/b2b/start/game", level: "err", has: ["ожидается boolean", "не входит в допустимые", "лишняя запятая"] },
    text: `curl -X POST 'https://transaction.uat.agg.bet/api/v1/b2b/start/game' -H 'Authorization: Bearer <token>' -H 'b2b-client-id: ${UUID}' -H 'request-id: ${UUID}' -H 'Content-Type: application/json' -d '{"game_id":"${UUID}","is_test":"true","browser_session":{"device":"Desktop"},}'` },
  { name: "Ответ из мессенджера: потерянные \\ перед кавычками", exp: { op: null, has: ["client_id\\\" is expected as UUID", "должен быть UUID"] },
    text: `Ответ:\n{“error”:“”client_id” is expected as UUID”}` },
  { name: "Ответ не JSON — простой текст ошибки", exp: { op: null, has: ["не является валидным JSON", "должен быть UUID"] },
    text: `Ответ:\nerror: client_id is expected as UUID` },
  { name: "Go-лог: URL строкой, Method:POST, Headers:map / Body:map", exp: { op: "POST /api/v1/b2b/deposit", has: ["лог Go-сервиса", "Обязательные поля на месте"], not: ["Тела запроса нет"] },
    text: `https://transaction.uat.agg.bet/api/v1/b2b/deposit\nMethod:POST\n\nHeaders:map[Authorization:Bearer <token> Content-Type:application/json b2b-client-id:${UUID} vendor-id:89ad7ebc-6732-11ed-9022-0242ac120002]\n\nBody:map[amount:100 b2c_id:test_player currency:BRL transaction_id:00291d2529] Timeout:60}` },
  { name: "Связь ответа с запросом: client-id не UUID", exp: { has: ["заголовок client-id = \"12345\" — это не UUID"] },
    text: `curl -X POST 'https://transaction.uat.agg.bet/api/v1/gate/deposit' -H 'client-id: 12345' -H 'Content-Type: application/json' -d '{}'\nОтвет: {"error":"\\"client_id\\" is expected as UUID"}` },
  { name: "Связь ответа с запросом: connection not found → пара ID", exp: { has: ["В запросе: b2b-client-id = " + UUID] },
    text: `curl -X POST 'https://transaction.uat.agg.bet/api/v1/b2b/deposit' -H 'b2b-client-id: ${UUID}' -H 'vendor-id: 8f3d22d6-591f-11ed-9b6a-0242ac120002' -H 'Content-Type: application/json' -d '{}'\nОтвет: {"error":"b2b ID=\\"x\\", vendor ID=\\"y\\": connection not found"}` },
  { name: "Round Check: round_id <vendor_id>_<round>", exp: { op: "POST /api/v1/b2b/reports/round-check", has: ["вендор Winfinity"] },
    text: `curl -X POST 'https://transaction.uat.agg.bet/api/v1/b2b/reports/round-check' -H 'Content-Type: application/json' -d '{"round_id":"8f3d22d6-591f-11ed-9b6a-0242ac120002_abc","b2c_id":"1","game_id":"g"}'` },
  { name: "PROD-хост и тестовые данные", exp: { has: ["тестовые признаки"] },
    text: `curl -X POST 'https://transaction.agg.bet/api/v1/b2b/token' -H 'Content-Type: application/json' -d '{"api_key":"k","b2b_id":"test_player"}'` },
  { name: "Mancala: строка для Hash", exp: { op: "POST /api/v1/vendor/Debit", has: ["Строка для Hash: \"Debit/\" + SessionId(s1)"] },
    text: `POST https://89ad7ebc673211ed90220242ac120002.transaction.uat.agg.bet/api/v1/vendor/Debit\nContent-Type: application/json\n\n{"SessionId":"s1","RoundGuid":"r1","TransactionGuid":"t1","Amount":2.5,"DebitType":2,"Hash":"0123456789abcdef0123456789abcdef","BonusTransaction":false,"ExternalBonusId":""}` },
  { name: "Секреты не попадают в текст для ИИ", exp: { op: "POST /api/v1/b2b/token", maskedNot: ["testkey0000", "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.c2lnbmF0dXJl"] },
    text: `curl -X POST 'https://transaction.uat.agg.bet/api/v1/b2b/token' -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.c2lnbmF0dXJl' -H 'Content-Type: application/json' -d '${TOKEN_BODY}'` }
];

(async () => {
  const SUPPORT_PW = process.env.SUPPORT_PW;
  if (!SUPPORT_PW) { console.log("  ⚠ SUPPORT_PW не задан — тесты проверки пропущены."); process.exit(0); }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL);
  await page.fill("#gate-pw", SUPPORT_PW);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  let fail = 0;
  for (const c of CASES) {
    const r = await page.evaluate((t) => { const p = window.PortalCheck.run(t); return { level: p.level, report: p.report, masked: p.masked, found: (p.report.match(/^Эндпоинт: (\S+ \S+)/m) || [])[1] || null }; }, c.text);
    const problems = [];
    const e = c.exp;
    if ("op" in e && r.found !== e.op) problems.push(`эндпоинт ${r.found} вместо ${e.op}`);
    if (e.level && r.level !== e.level) problems.push(`вердикт ${r.level} вместо ${e.level}`);
    (e.has || []).forEach((s) => { if (r.report.indexOf(s) < 0) problems.push(`нет «${s}»`); });
    (e.not || []).forEach((s) => { if (r.report.indexOf(s) >= 0) problems.push(`лишнее «${s}»`); });
    (e.maskedNot || []).forEach((s) => { if (r.masked.indexOf(s) >= 0) problems.push(`секрет «${s.slice(0, 8)}…» ушёл бы в ИИ`); });
    if (problems.length) { fail++; console.log("  ✗ " + c.name + " — " + problems.join("; ")); }
    else console.log("  ✓ " + c.name);
  }
  /* «Исправить запрос» и MD5 */
  const extra = await page.evaluate(() => {
    const f = window.PortalCheck.fix(`curl -X GET "http://transaction.uat.agg.bet/api/v1/b2b/start/game/" -H "b2b-client-id: 11111111-2222-4333-8444-555555555555" -d "{\\"gameId\\":\\"x\\",\\"is_test\\":\\"true\\",\\"browser_session\\":{\\"device\\":\\"Desktop\\"}}"`);
    return { curl: f && f.curl, changes: f && f.changes.join(" | "), md5: window.PortalCheck.md5("hello") };
  });
  const fixChecks = [
    ["md5", extra.md5 === "5d41402abc4b2a76b9719d911017c592"],
    ["метод и https", /^curl -X POST 'https:\/\/transaction\.uat\.agg\.bet\/api\/v1\/b2b\/start\/game'/.test(extra.curl || "")],
    ["Bearer-плейсхолдер", /Authorization: Bearer <token>/.test(extra.curl || "")],
    ["опечатка gameId → game_id", /"game_id": "x"/.test(extra.curl || "")],
    ["boolean без кавычек", /"is_test": true/.test(extra.curl || "")],
    ["регистр enum", /"device": "desktop"/.test(extra.curl || "")],
    ["плейсхолдеры обязательных", /обязательные поля с плейсхолдерами/.test(extra.changes || "")]
  ];
  fixChecks.forEach((c) => { if (c[1]) console.log("  ✓ Исправить запрос: " + c[0]); else { fail++; console.log("  ✗ Исправить запрос: " + c[0]); } });
  if (errors.length) { fail++; console.log("  ✗ ошибки JS: " + errors.join(" | ")); }
  console.log(`\n${CASES.length + 7 - fail + (errors.length ? 1 : 0)} пройдено, ${fail} упало`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
