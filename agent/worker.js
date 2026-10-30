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
  "Ты — ассистент с доступом к веб-поиску. Это РЕЖИМ ОБЩЕГО ОТВЕТА: пользователь",
  "не нашёл ответ во внутренней документации портала и просит общий ответ из интернета.",
  "",
  "ПРАВИЛА:",
  "1. Отвечай на русском языке.",
  "2. Отвечай по своим знаниям и результатам веб-поиска; это общая информация, а не",
  "   документация их компании. Не выдавай общие сведения за внутренние регламенты портала.",
  "3. Если уверенности нет — честно скажи об этом.",
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

    const key = env.GEMINI_API_KEY;
    if (!key) return json({ error: "GEMINI_API_KEY не задан в воркере" }, 500, headers);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Плохой JSON" }, 400, headers); }

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
    // В режиме web включаем веб-поиск Google (grounding)
    if (mode === "web") payload.tools = [{ google_search: {} }];

    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);

    let res = await callGemini(url, payload);

    // Если веб-поиск не поддержан на этом ключе/модели — повторяем без него
    if (mode === "web" && !res.ok && /tool|google_search|search|function/i.test(res.errMsg || "")) {
      delete payload.tools;
      res = await callGemini(url, payload);
      res.degraded = true;
    }

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
