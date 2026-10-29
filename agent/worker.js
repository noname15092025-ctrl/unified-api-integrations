/**
 * API Portal — AI agent proxy (Cloudflare Worker)
 * ------------------------------------------------
 * Держит ключ модели в секрете (на стороне Cloudflare), чтобы его НЕ было
 * в публичном репозитории/коде сайта. Прокси к Google Gemini.
 *
 * Деплой и настройка — см. agent/README.md
 *
 * Переменные окружения воркера:
 *   GEMINI_API_KEY  (secret, обязателен)  — ключ из Google AI Studio
 *   MODEL           (var, необязателен)   — по умолчанию "gemini-2.5-flash"
 *   ALLOW_ORIGIN    (var, необязателен)   — домен сайта, напр.
 *                                           "https://noname15092025-ctrl.github.io"
 *                                           по умолчанию "*"
 */

const SYSTEM_PROMPT = [
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
      return new Response(JSON.stringify({ error: "Only POST" }), {
        status: 405, headers: { ...headers, "Content-Type": "application/json" }
      });
    }

    const key = env.GEMINI_API_KEY;
    if (!key) {
      return new Response(JSON.stringify({ error: "GEMINI_API_KEY не задан в воркере" }), {
        status: 500, headers: { ...headers, "Content-Type": "application/json" }
      });
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Плохой JSON" }, 400, headers); }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const context = typeof body.context === "string" ? body.context.slice(0, 900000) : "";
    if (!messages.length) return json({ error: "Пустой запрос" }, 400, headers);

    const model = (env.MODEL || "gemini-2.5-flash").trim();

    // История диалога -> формат Gemini
    const contents = messages.slice(-12).map(m => ({
      role: m.role === "model" || m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.text || "").slice(0, 8000) }]
    }));

    const sys = SYSTEM_PROMPT +
      "\n\n===== МАТЕРИАЛЫ ПОРТАЛА (используй как единственный источник) =====\n" +
      context;

    const payload = {
      system_instruction: { parts: [{ text: sys }] },
      contents,
      generationConfig: { temperature: 0.2, maxOutputTokens: 1600, topP: 0.9 },
      safetySettings: [
        "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"
      ].map(category => ({ category, threshold: "BLOCK_NONE" }))
    };

    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);

    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      return json({ error: "Не удалось связаться с моделью: " + e.message }, 502, headers);
    }

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ("HTTP " + r.status);
      return json({ error: "Ошибка модели: " + msg }, r.status, headers);
    }

    const cand = data.candidates && data.candidates[0];
    const text = cand && cand.content && cand.content.parts
      ? cand.content.parts.map(p => p.text || "").join("")
      : "";
    if (!text) {
      const fin = cand && cand.finishReason ? (" (" + cand.finishReason + ")") : "";
      return json({ error: "Пустой ответ модели" + fin }, 200, headers);
    }

    return json({ text }, 200, headers);
  }
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...headers, "Content-Type": "application/json" }
  });
}
