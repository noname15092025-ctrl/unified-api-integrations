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

  await check("FAQ: категория показывает источники и вопросы, страница — крошки и ссылку на Confluence", async () => {
    await go("#/faq/support");
    assert.ok(await page.$$eval(".src-head", (e) => e.length) >= 2, "мало источников");
    assert.ok(await page.$$eval("details.qa", (e) => e.length) >= 5, "мало вопросов");
    await go("#/faq/support/1331691558");
    const crumbs = await page.$eval(".crumbs", (e) => e.textContent);
    assert.ok(/FAQ \/ Support \/ /.test(crumbs), crumbs);
    assert.strictEqual(await page.$$eval("details.qa", (e) => e.length), 4);
    assert.ok(await page.$eval(".cat-note a", (a) => /atlassian\.net/.test(a.href)), "нет ссылки на Confluence");
  });

  await check("FAQ: постоянная ссылка #/faq/<кат>/<стр>/<n> раскрывает вопрос", async () => {
    await go("#/faq/support/1331691558/2");
    const id = await page.$eval("details.qa[open]", (e) => e.id);
    assert.strictEqual(id, "qa-1331691558-2");
  });

  await check("FAQ: у страницы с PDF есть кнопка «Скачать PDF» на файл", async () => {
    await go("#/faq/support/winfinity-localization");
    const a = await page.$eval(".file-download-box a.file-download", (a) => [a.textContent, a.getAttribute("href")]);
    assert.strictEqual(a[0], "Скачать PDF");
    assert.ok(/Winfinity_Blocked_Territories/.test(a[1]), a[1]);
  });

  await check("FAQ: фильтр в боковой панели оставляет только подходящие категории", async () => {
    await go("#/faq");
    const all = await page.$$eval(".side .op-link", (e) => e.length);
    await page.fill("#faq-filter", "KIDR");
    await page.waitForTimeout(200);
    const n = await page.$$eval(".side .op-link", (e) => e.length);
    assert.ok(n >= 1 && n < all, all + " -> " + n);
    assert.strictEqual(await page.$eval("#faq-filter", (e) => e === document.activeElement), true, "фокус потерян");
  });

  await check("справочник #/ref/<стр> открывается со ссылкой на Confluence", async () => {
    await go("#/ref/1506279677");
    assert.strictEqual(await page.$eval("h1.cat-head", (e) => e.textContent), "Bonus campaign");
    assert.ok(await page.$eval(".cat-note a", (a) => /atlassian\.net/.test(a.href)));
  });

  await check("FAQ TG: у ответа есть ссылки на источник в Telegram", async () => {
    await go("#/faq-tg");
    const n = await page.$$eval("details.qa .tg-src a", (e) => e.filter((a) => /telegram|t\.me/.test(a.href)).length);
    assert.ok(n > 10, "ссылок: " + n);
  });

  await check("Postman: блок файла с кнопкой скачивания коллекции и источниками", async () => {
    await go("#/doc-postman");
    const a = await page.$eval(".file-download-box a.file-download", (a) => a.getAttribute("href"));
    assert.ok(/SV\.postman_collection\.json$/.test(a), a);
    assert.ok(await page.$$eval(".file-download-info a", (e) => e.length) >= 1, "нет ссылок на источники");
  });

  await check("Back Office: блок источников без кнопки скачивания", async () => {
    await go("#/doc-backoffice");
    assert.ok(await page.$(".file-download-box .file-download-info a"), "нет источников");
    assert.strictEqual(await page.$(".file-download-box a.file-download"), null);
  });

  await check("документ: клик по разделу в содержании прокручивает к нему", async () => {
    await go("#/doc-backoffice");
    const btns = await page.$$(".side [data-doc-section]");
    assert.ok(btns.length > 5);
    await btns[5].click();
    await page.waitForTimeout(1200);
    const top = await page.$eval("#doc-backoffice-section-5", (e) => e.getBoundingClientRect().top);
    assert.ok(top >= -5 && top < 200, "раздел не наверху: " + top);
  });

  await check("кнопка «Копировать» копирует текст ответа без служебных строк", async () => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await go("#/faq-slack/access/0");
    await page.reload();
    await page.waitForTimeout(400);
    await page.$eval("details.qa[open] .qa-copy", (b) => { b.scrollIntoView({ block: "center" }); b.click(); });
    await page.waitForTimeout(200);
    const t = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(t.length > 20 && !/Источник в Slack/.test(t) && !/Копировать/.test(t), t.slice(0, 80));
  });

  await check("Back Office: раздел Whitelist / Blacklist игр со скриншотом и путём Game access → Black list", async () => {
    await go("#/doc-backoffice");
    const side = await page.$$eval(".side [data-doc-section] .p", (e) => e.map((x) => x.textContent));
    assert.ok(side.some((t) => /Whitelist \/ Blacklist игр/.test(t)), "нет пункта в содержании");
    const sec = await page.evaluate(() => {
      const h = [...document.querySelectorAll("#content h2")].find((x) => /Whitelist \/ Blacklist игр/.test(x.textContent));
      if (!h) return null;
      let t = "", img = null;
      for (let n = h.nextElementSibling; n && n.tagName !== "H2" && n.tagName !== "H1"; n = n.nextElementSibling) {
        t += n.textContent + " ";
        img = img || n.querySelector("img");
      }
      if (img) img.scrollIntoView();
      return { t, src: img && img.getAttribute("src") };
    });
    await page.waitForTimeout(800);
    if (sec) sec.ok = await page.$eval('img[src="' + sec.src + '"]', (i) => i.complete && i.naturalWidth > 0);
    assert.ok(sec, "нет раздела");
    assert.ok(/B2B MANAGEMENT/.test(sec.t) && /Game access/.test(sec.t) && /Black list/.test(sec.t) && /Grant access/.test(sec.t) && /failed/.test(sec.t), sec.t.slice(0, 200));
    assert.ok(sec.src && sec.ok, "картинка не загрузилась: " + sec.src);
  });

  await check("поиск: «blacklist» и «чёрный список» находят раздел Back Office", async () => {
    await go("#/b2b");
    for (const q of ["blacklist", "чёрный список"]) {
      await page.fill("#search", q);
      await page.waitForTimeout(250);
      const t = await page.$$eval("#results .res .t", (e) => e.map((x) => x.textContent));
      assert.ok(t.some((x) => /Back Office/.test(x)), q + ": " + t.slice(0, 8).join(" | "));
    }
  });

  await check("Back Office: в самом верху выделенный блок с новыми адресами БО (прод и UAT, AGG / Winfinity / Mancala)", async () => {
    await go("#/doc-backoffice");
    const r = await page.evaluate(() => {
      const body = document.querySelector("#content .doc-body");
      const first = body && body.firstElementChild;
      return first && { cls: first.className, text: first.textContent, links: [...first.querySelectorAll("a")].map((a) => a.href) };
    });
    assert.ok(r && /md-panel-warning/.test(r.cls), "первым идёт не выделенный блок: " + (r && r.cls));
    for (const u of ["https://aggbet.backofficego.com/", "https://winfinity.backofficego.com/", "https://mancala.backofficego.com/",
      "https://aggbet.uat.backofficego.com/", "https://winfinity.uat.backofficego.com/", "https://mancala.uat.backofficego.com/"]) {
      assert.ok(r.links.indexOf(u) >= 0, "нет ссылки " + u);
    }
    assert.ok(/Winfinity/.test(r.text) && /Mancala/.test(r.text) && /брендинг/.test(r.text), r.text.slice(0, 200));
    assert.strictEqual(await page.$eval("#content .doc-body > .md-panel-warning .md-panel-title", (e) => e.textContent), "Новые адреса Бэк-офиса");
  });

  await check("старого адреса БО fr.agg.bet больше нет", async () => {
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    assert.ok(!/fr\.agg\.bet/.test(html));
  });

  await check("на сайте нет ошибок JavaScript", async () => {
    assert.deepStrictEqual(errors, []);
  });

  await browser.close();
  results.forEach(([s, n]) => console.log((s === "ok" ? "  ✓ " : "  ✗ ") + n));
  const failed = results.filter((r) => r[0] !== "ok").length;
  console.log("\n" + (results.length - failed) + " пройдено, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();
