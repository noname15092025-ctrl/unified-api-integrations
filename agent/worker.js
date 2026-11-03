/**
 * API Portal — AI agent proxy (Cloudflare Worker)
 * ------------------------------------------------
 * Держит ключ модели в секрете (на стороне Cloudflare), чтобы его НЕ было
 * в публичном репозитории/коде сайта. Прокси к Google Gemini.
 *
 * Два режима (поле body.mode):
 *   "portal" (по умолчанию) — отвечает ТОЛЬКО по материалам портала.
 *   "web" — общий ответ: знания модели + веб-поиск Google (grounding).
 *
 * Деплой и настройка — см. agent/README.md
 *
 * Переменные окружения воркера:
 *   GEMINI_API_KEY  (secret, обязателен)  — ключ из Google AI Studio
 *   MODEL           (var, необязателен)   — по умолчанию "gemini-2.5-flash-lite"
 *   ALLOW_ORIGIN    (var, необязателен)   — домен сайта
 */

const PORTAL_PROMPT = [
  "Ты — ассистент внутреннего портала документации по API интеграций",
  "(агрегатор ставок: B2B API, Aggregator API, Provider API, Mancala, BroIT и смежные).",
  "Твоя задача — помогать команде поддержки и интеграции: анализировать переданные",
  "материалы портала и давать развёрнутый, но по делу ответ.",
  "",
  "ПРАВИЛА:",
  "1. Отвечай на русском языке.",
  "2. Опирайся ТОЛЬКО на переданные материалы портала (оглавление API и выдержки).",
  "   Если данных в материалах не хватает — честно скажи об этом и не выдумывай",
  "   эндпоинты, поля, коды ошибок или значения.",
  "3. Если уместно — ссылайся на конкретный эндпоинт (METHOD /path) или раздел FAQ.",
  "4. Форматируй ответ в Markdown (заголовки, списки, блоки кода для JSON/URL).",
  "5. Никогда не раскрывай и не придумывай логины, пароли, токены, API-ключи.",
  "6. Это вспомогательный инструмент: твой ответ — предположение по документации,",
  "   а не истина в последней инстанции."
].join("\n");

const WEB_PROMPT = [
  "Это РЕЖИМ ОБЩЕГО ОТВЕТА: пользователь не нашёл ответ во внутренней документации",
  "портала и просит общий ответ. Отвечай на основе своих общих знаний (модель",
  "обучена на большом массиве данных из интернета).",
  "",
  "ПРАВИЛА:",
  "1. Отвечай на русском языке.",
  "2. Это общая информация, а не документация их компании. Не выдавай общие сведения",
  "   за внутренние регламенты портала.",
  "3. Если не уверен или данные могли устареть — честно предупреди об этом.",
  "4. Форматируй ответ в Markdown.",
  "5. Никогда не раскрывай и не придумывай чужие логины, пароли, токены, ключи."
].join("\n");

function cors(origin, allow) {
  const o = (allow && allow !== "*") ? allow : (origin || "*");
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = cors(origin, env.ALLOW_ORIGIN);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") {
      return json({ error: "Only POST" }, 405, headers);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Плохой JSON" }, 400, headers); }

    // --- Сохранение правки страницы в GitHub (редактор на сайте) ---
    if (body.op === "commit") return handleCommit(body, env, headers);

    // --- Агент ---
    const key = env.GEMINI_API_KEY;
    if (!key) return json({ error: "GEMINI_API_KEY не задан в воркере" }, 500, headers);

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const context = typeof body.context === "string" ? body.context.slice(0, 900000) : "";
    const mode = body.mode === "web" ? "web" : "portal";
    if (!messages.length) return json({ error: "Пустой запрос" }, 400, headers);

    const model = (env.MODEL || "gemini-2.5-flash-lite").trim();

    const contents = messages.slice(-12).map(m => ({
      role: m.role === "model" || m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.text || "").slice(0, 8000) }]
    }));

    const sys = mode === "web"
      ? WEB_PROMPT
      : PORTAL_PROMPT + "\n\n===== МАТЕРИАЛЫ ПОРТАЛА (используй как единственный источник) =====\n" + context;

    const payload = {
      system_instruction: { parts: [{ text: sys }] },
      contents,
      generationConfig: { temperature: mode === "web" ? 0.4 : 0.2, maxOutputTokens: 1600, topP: 0.9 },
      safetySettings: [
        "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"
      ].map(category => ({ category, threshold: "BLOCK_NONE" }))
    };
    // Примечание: живой веб-поиск Google (grounding) на бесплатном тарифе
    // упирается в отдельную маленькую квоту и быстро выдаёт "quota exceeded".
    // Поэтому web-режим отвечает на основе знаний модели, в рамках обычной
    // бесплатной квоты. (Чтобы включить реальный поиск — см. ветку с tools.)

    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);

    const res = await callGemini(url, payload);

    if (res.netError) return json({ error: "Не удалось связаться с моделью: " + res.errMsg }, 502, headers);
    if (!res.ok) return json({ error: "Ошибка модели: " + res.errMsg }, res.status, headers);
    if (!res.text) return json({ error: "Пустой ответ модели" + (res.finish ? " (" + res.finish + ")" : "") }, 200, headers);

    return json({ text: res.text, mode, degraded: !!res.degraded }, 200, headers);
  }
};

async function callGemini(url, payload) {
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return { netError: true, errMsg: e.message };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || ("HTTP " + r.status);
    return { ok: false, status: r.status, errMsg: msg };
  }
  const cand = data.candidates && data.candidates[0];
  const text = cand && cand.content && cand.content.parts
    ? cand.content.parts.map(p => p.text || "").join("")
    : "";
  return { ok: true, text, finish: cand && cand.finishReason };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...headers, "Content-Type": "application/json" }
  });
}

/* ================== Сохранение правки страницы в GitHub ================== */

async function handleCommit(body, env, headers) {
  const token = env.GITHUB_TOKEN;
  const editPw = env.EDIT_PASSWORD;
  if (!token) return json({ error: "GITHUB_TOKEN не задан в воркере" }, 500, headers);
  if (!editPw) return json({ error: "EDIT_PASSWORD не задан в воркере" }, 500, headers);
  if (String(body.password || "") !== String(editPw)) return json({ error: "Неверный пароль редактирования" }, 403, headers);

  const change = body.change;
  if (!change || (change.type !== "refmd" && change.type !== "locked")) {
    return json({ error: "Некорректная правка" }, 400, headers);
  }
  const message = (typeof body.message === "string" && body.message.trim()) || "Правка со страницы портала";

  try {
    const sha = await githubCommit(env, token, change, message);
    return json({ ok: true, commit: sha }, 200, headers);
  } catch (e) {
    return json({ error: "GitHub: " + e.message }, 502, headers);
  }
}

function b64encUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
function b64decUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function applyChange(html, change) {
  const m = html.match(/(<script type="application\/json" id="portal-data">)([\s\S]*?)(<\/script>)/);
  if (!m) throw new Error("portal-data не найден в index.html");
  const d = JSON.parse(m[2]);
  if (change.type === "refmd") {
    const r = ((d.faq && d.faq.reference) || []).find(x => String(x.page) === String(change.page));
    if (!r) throw new Error("справочная страница не найдена: " + change.page);
    r.md = String(change.md);
  } else if (change.type === "locked") {
    if (!change.id || !change.enc) throw new Error("нет данных зашифрованного блока");
    d.locked = d.locked || {};
    d.locked[change.id] = change.enc;
  }
  const nj = JSON.stringify(d);
  return html.slice(0, m.index) + m[1] + nj + m[3] + html.slice(m.index + m[0].length);
}

async function githubCommit(env, token, change, message) {
  const repo = (env.GITHUB_REPO || "noname15092025-ctrl/unified-api-integrations").split("/");
  const owner = repo[0], name = repo[1];
  const branch = env.GITHUB_BRANCH || "main";
  const DUP = "Единая_API_интеграции_актуальная.html";
  const api = "https://api.github.com";
  const H = {
    "Authorization": "Bearer " + token,
    "Accept": "application/vnd.github+json",
    "User-Agent": "api-portal-worker",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const HJ = { ...H, "Content-Type": "application/json" };
  const gj = async (url, opt) => {
    const r = await fetch(url, opt);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j && j.message) || ("HTTP " + r.status));
    return j;
  };

  const ref = await gj(`${api}/repos/${owner}/${name}/git/ref/heads/${branch}`, { headers: H });
  const commitSha = ref.object.sha;
  const commit = await gj(`${api}/repos/${owner}/${name}/git/commits/${commitSha}`, { headers: H });
  const baseTree = commit.tree.sha;

  const file = await gj(`${api}/repos/${owner}/${name}/contents/index.html?ref=${branch}`, { headers: H });
  const html = applyChange(b64decUtf8(file.content), change);

  const blob = await gj(`${api}/repos/${owner}/${name}/git/blobs`, {
    method: "POST", headers: HJ,
    body: JSON.stringify({ content: b64encUtf8(html), encoding: "base64" })
  });
  const tree = await gj(`${api}/repos/${owner}/${name}/git/trees`, {
    method: "POST", headers: HJ,
    body: JSON.stringify({
      base_tree: baseTree,
      tree: [
        { path: "index.html", mode: "100644", type: "blob", sha: blob.sha },
        { path: DUP, mode: "100644", type: "blob", sha: blob.sha }
      ]
    })
  });
  const newCommit = await gj(`${api}/repos/${owner}/${name}/git/commits`, {
    method: "POST", headers: HJ,
    body: JSON.stringify({ message, tree: tree.sha, parents: [commitSha] })
  });
  await gj(`${api}/repos/${owner}/${name}/git/refs/heads/${branch}`, {
    method: "PATCH", headers: HJ,
    body: JSON.stringify({ sha: newCommit.sha })
  });
  return newCommit.sha;
}
