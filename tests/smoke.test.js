/*
 * Поведенческие тесты портала: открывают index.html в браузере так же, как пользователь,
 * и проверяют то, что пользователь видит.
 * Запуск: NODE_PATH=$(npm root -g) node tests/smoke.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const URL = "file://" + path.join(ROOT, "index.html");
const results = [];

async function check(name, fn) {
  try { await fn(); results.push(["ok", name]); }
  catch (e) { results.push(["FAIL", name + " — " + e.message.split("\n")[0]]); }
}

async function searchTitles(page, q) {
  await page.fill("#search", q);
  await page.waitForTimeout(250);
  return page.$$eval("#results .res .t", (els) => els.map((e) => e.textContent));
}

(async () => {
  await check("копия Единая_API_интеграции_актуальная.html совпадает с index.html", async () => {
    const a = fs.readFileSync(path.join(ROOT, "index.html"));
    const b = fs.readFileSync(path.join(ROOT, "Единая_API_интеграции_актуальная.html"));
    assert.ok(a.equals(b), "файлы различаются");
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const go = async (hash) => { await page.goto(URL + hash); await page.waitForTimeout(400); };

  const tabs = ["b2b", "aggr", "mancala", "broit", "mancala-fs", "round-check", "bet-history",
    "doc-backoffice", "doc-incidents", "doc-postman", "doc-testops", "faq", "faq-tg", "faq-slack"];
  for (const t of tabs) {
    await check("вкладка #/" + t + " открывается, активна и не пустая", async () => {
      await go("#/" + t);
      const active = await page.$eval(".tab.active", (e) => e.dataset.tab);
      assert.strictEqual(active, t);
      const text = await page.$eval("#content", (e) => e.innerText.trim().length);
      assert.ok(text > 100, "мало текста: " + text);
    });
  }

  await check("счётчики на вкладках не нулевые", async () => {
    await go("#/b2b");
    const zero = await page.$$eval(".tab[data-tab] .cnt", (els) =>
      els.filter((e) => e.textContent.trim() === "0").map((e) => e.parentElement.dataset.tab));
    assert.deepStrictEqual(zero, []);
  });

  await check("поиск: KIDR находит ответ про KVND/KIDR", async () => {
    await go("#/b2b");
    const t = await searchTitles(page, "KIDR");
    assert.ok(t.some((x) => /KIDR/.test(x)), t.join(" | "));
  });

  await check("поиск: русский запрос «возврат» находит английский refund-метод", async () => {
    const t = await searchTitles(page, "возврат");
    assert.ok(t.some((x) => /refund/i.test(x)), t.slice(0, 10).join(" | "));
  });

  await check("поиск, словарь: «генерация токена» находит метод /api/v1/b2b/token", async () => {
    const t = await searchTitles(page, "генерация токена");
    assert.ok(t.some((x) => /\/api\/v1\/b2b\/token/.test(x)), t.slice(0, 10).join(" | "));
  });

  await check("поиск, переводы: «недостаточно средств» находит метод /<path-for-refund> (текст там только английский)", async () => {
    const t = await searchTitles(page, "недостаточно средств");
    assert.ok(t.some((x) => /path-for-refund>/.test(x)), t.slice(0, 10).join(" | "));
  });

  await check("поиск: английский запрос refund находит русский текст «возврат»", async () => {
    const t = await searchTitles(page, "refund");
    assert.ok(t.some((x) => /возврат/i.test(x)), t.slice(0, 20).join(" | "));
  });

  await check("поиск: окончания не мешают («ставки» находит «ставка»)", async () => {
    const t = await searchTitles(page, "ставки");
    assert.ok(t.some((x) => /ставк/i.test(x)), t.slice(0, 10).join(" | "));
  });

  await check("поиск: клик по результату FAQ Slack открывает нужный вопрос", async () => {
    await searchTitles(page, "KVND KIDR");
    await page.click("#results .res >> text=FAQ Slack");
    await page.waitForTimeout(400);
    const open = await page.$eval("details.qa[open] summary", (e) => e.textContent);
    assert.ok(/KIDR/.test(open), open);
  });

  await check("FAQ Slack: у каждого вопроса есть ссылка «открыть тред» на Slack", async () => {
    await go("#/faq-slack");
    const r = await page.$$eval("details.qa", (qs) => qs.map((q) => {
      const a = q.querySelector(".tg-src a");
      return a && a.textContent === "открыть тред" && /^https:\/\/aggregator-broit\.slack\.com\/archives\/C\w+\/p\d{16}$/.test(a.href);
    }));
    assert.ok(r.length >= 100, "вопросов: " + r.length);
    assert.ok(r.every(Boolean), "без ссылки: " + r.filter((x) => !x).length);
    assert.strictEqual(await page.$$eval("summary a", (e) => e.length), 0, "в строке вопроса не должно быть ссылок");
  });

  await check("FAQ Slack: английские термины переводятся при наведении", async () => {
    await go("#/faq-slack/bonus");
    await page.click("details.qa summary");
    const term = await page.$("details.qa[open] .sl-term");
    assert.ok(term, "нет терминов с переводом");
    await term.hover();
    await page.waitForTimeout(150);
    const tip = await page.$eval(".ru-tip", (e) => (e.hidden ? "" : e.textContent));
    assert.ok(/[а-я]/i.test(tip), "подсказка пустая");
  });

  await check("постоянная ссылка #/faq-slack/<тема>/<n> открывает вопрос", async () => {
    await go("#/faq-slack/access/0");
    assert.ok(await page.$("details.qa[open]"), "вопрос не раскрыт");
  });

  await check("подвал с ссылкой на Slack Ilya Belavusau есть на страницах", async () => {
    for (const h of ["#/b2b", "#/faq", "#/doc-postman"]) {
      await go(h);
      const href = await page.$eval(".site-foot a", (a) => a.href);
      assert.ok(/slack\.com\/team\/U\w+/.test(href), h + ": " + href);
    }
  });

  await check("UAT БО везде новый адрес, старого fr.uat.agg.bet нет", async () => {
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    assert.ok(!/fr\.uat\.agg\.bet/.test(html));
    assert.ok(/aggbet\.uat\.backofficego\.com/.test(html));
  });

  await check("тёмная тема переключается и запоминается", async () => {
    await go("#/b2b");
    await page.click("#theme-toggle");
    await go("#/faq");
    assert.strictEqual(await page.$eval("html", (e) => e.getAttribute("data-theme")), "dark");
    await page.click("#theme-toggle");
  });

  for (const [tab, input, word] of [["faq-tg", "#tg-filter", "refund"], ["faq-slack", "#sl-filter", "KIDR"]]) {
    await check("фильтр вопросов на вкладке " + tab + " сужает список и считает темы", async () => {
      await go("#/" + tab);
      const all = await page.$$eval("details.qa", (e) => e.length);
      await page.fill(input, word);
      await page.waitForTimeout(200);
      const n = await page.$$eval("details.qa", (e) => e.length);
      assert.ok(n > 0 && n < all, all + " -> " + n);
      const side = await page.$eval(".side .op-link .p", (e) => e.textContent);
      assert.ok(side.indexOf(String(n)) >= 0, "в «Все вопросы» не " + n + ": " + side);
      assert.strictEqual(await page.$eval(input, (e) => e === document.activeElement), true, "фокус потерян");
      await page.click(".side .op-link:nth-child(2)");
      await page.waitForTimeout(200);
      assert.ok(new RegExp("#/" + tab + "/\\w+$").test(page.url()), page.url());
    });
  }

  await check("на сайте нет ошибок JavaScript", async () => {
    assert.deepStrictEqual(errors, []);
  });

  await browser.close();
  results.forEach(([s, n]) => console.log((s === "ok" ? "  ✓ " : "  ✗ ") + n));
  const failed = results.filter((r) => r[0] !== "ok").length;
  console.log("\n" + (results.length - failed) + " пройдено, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();
