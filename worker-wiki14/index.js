// wiki14 Gemini proxy + Google Sheets fetch — Cloudflare Worker
//
// Three routes:
//   /resolve-styles (also served at the bare root "/" for backwards
//   compatibility with callers deployed before this route existed): when
//   the static site's deterministic paragraph-matching can't align a
//   translated paragraph range to an EN styled section (paragraph counts
//   don't match), asks Gemini to resolve the range and hands back JSON.
//   The Gemini API key lives only here, as a Worker secret — it is never
//   sent to or visible in the browser.
//
//   /resolve-subphrase: when a single EN line mixes multiple styles WITHIN
//   itself (e.g. a plain lead-in immediately followed by a bold clause, no
//   line break between), there's no structural anchor to place the
//   equivalent styling in translated text — word order and phrasing differ
//   too much across languages. Given the EN line for context, the exact
//   styled substring, and the already-known target line's plain text, asks
//   Gemini to find the matching substring in the target text.
//
//   /fetch-sheet: fetches a Google Sheet's CSV export server-side, since
//   Google's export endpoint doesn't reliably send CORS headers for a
//   direct browser fetch. Requires the same x-app-token as the resolve
//   route. Detects when Google hands back a login/"request access" HTML
//   page instead of CSV (it doesn't cleanly 403 a private sheet) and
//   reports that as a clear sharing-settings error instead of returning
//   the HTML as if it were data.
//
// Deploy:
//   wrangler secret put GEMINI_API_KEY
//   wrangler secret put APP_TOKEN        (any random string you invent)
//   wrangler deploy
//
// Then set ALLOWED_ORIGIN below to your GitHub Pages origin, and put the
// same APP_TOKEN value into site/app.js (see the CONFIG block there).

const ALLOWED_ORIGIN = "https://zitian-ff.github.io";

const GEMINI_MODEL = "gemini-flash-latest"; // check ai.google.dev for the current fast/cheap tier

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          style: { type: "string" },
          start: { type: "integer" },
          end: { type: "integer" },
          confidence: { type: "string", enum: ["high", "low"] },
        },
        required: ["style", "start", "end", "confidence"],
      },
    },
  },
  required: ["matches"],
};

const SUBPHRASE_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          target_text: { type: "string" },
          confidence: { type: "string", enum: ["high", "low"] },
        },
        required: ["id", "target_text", "confidence"],
      },
    },
  },
  required: ["matches"],
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }
    if (request.method !== "POST") {
      return withCors(new Response("Method not allowed", { status: 405 }));
    }

    // Not a real secret (it ships inside the public site's JS) — just a
    // speed bump so a stranger who stumbles on this URL can't casually
    // burn your Gemini quota or fetch-sheet allowance. Pair with
    // Cloudflare rate-limiting rules if this ever becomes a real concern.
    if (request.headers.get("x-app-token") !== env.APP_TOKEN) {
      return withCors(new Response("Unauthorized", { status: 401 }));
    }

    const { pathname } = new URL(request.url);
    if (pathname === "/fetch-sheet") {
      return handleFetchSheet(request);
    }
    if (pathname === "/resolve-subphrase") {
      return handleResolveSubphrase(request, env);
    }
    // "/resolve-styles" is the explicit path going forward; the bare root
    // "/" is kept working for any caller still deployed before this split.
    return handleResolveStyles(request, env);
  },
};

async function handleResolveStyles(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return withCors(new Response("Invalid JSON body", { status: 400 }));
  }

  const { style_runs, target_paragraphs } = payload;
  if (!Array.isArray(style_runs) || !Array.isArray(target_paragraphs)) {
    return withCors(
      jsonResponse({ error: "Missing style_runs or target_paragraphs" }, 400)
    );
  }

  const prompt = buildPrompt(style_runs, target_paragraphs);

  let geminiResp;
  try {
    geminiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0,
          },
        }),
      }
    );
  } catch (e) {
    return withCors(jsonResponse({ error: "Network error calling Gemini", detail: String(e) }, 502));
  }

  if (!geminiResp.ok) {
    const detail = await geminiResp.text();
    return withCors(jsonResponse({ error: "Gemini request failed", detail }, 502));
  }

  const geminiData = await geminiResp.json();
  let matches;
  try {
    const rawText = geminiData.candidates[0].content.parts[0].text;
    matches = JSON.parse(rawText);
  } catch (e) {
    return withCors(
      jsonResponse({ error: "Could not parse Gemini response", detail: String(e) }, 502)
    );
  }

  return withCors(jsonResponse(matches, 200));
}

async function handleResolveSubphrase(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return withCors(new Response("Invalid JSON body", { status: 400 }));
  }

  const { items } = payload;
  if (!Array.isArray(items)) {
    return withCors(jsonResponse({ error: "Missing items" }, 400));
  }

  const prompt = buildSubphrasePrompt(items);

  let geminiResp;
  try {
    geminiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: SUBPHRASE_RESPONSE_SCHEMA,
            temperature: 0,
          },
        }),
      }
    );
  } catch (e) {
    return withCors(jsonResponse({ error: "Network error calling Gemini", detail: String(e) }, 502));
  }

  if (!geminiResp.ok) {
    const detail = await geminiResp.text();
    return withCors(jsonResponse({ error: "Gemini request failed", detail }, 502));
  }

  const geminiData = await geminiResp.json();
  let matches;
  try {
    const rawText = geminiData.candidates[0].content.parts[0].text;
    matches = JSON.parse(rawText);
  } catch (e) {
    return withCors(
      jsonResponse({ error: "Could not parse Gemini response", detail: String(e) }, 502)
    );
  }

  return withCors(jsonResponse(matches, 200));
}

async function handleFetchSheet(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return withCors(jsonResponse({ error: "Invalid JSON body" }, 400));
  }

  const { sheetId, gid } = payload;
  if (!sheetId) {
    return withCors(jsonResponse({ error: "Missing sheetId" }, 400));
  }

  const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid || "0"}`;

  let sheetResp;
  try {
    sheetResp = await fetch(exportUrl);
  } catch (e) {
    return withCors(jsonResponse({ error: "Network error fetching the sheet", detail: String(e) }, 502));
  }

  const contentType = sheetResp.headers.get("content-type") || "";
  const body = await sheetResp.text();

  // Google doesn't cleanly 403 a private/restricted sheet — it redirects to
  // a login or "request access" HTML page instead (often with a 200
  // status). Detect that rather than silently handing back HTML as if it
  // were CSV.
  const trimmedBody = body.trimStart();
  const looksLikeHtml =
    contentType.includes("text/html") ||
    trimmedBody.startsWith("<!DOCTYPE") ||
    trimmedBody.startsWith("<html");

  if (!sheetResp.ok || looksLikeHtml) {
    return withCors(
      jsonResponse(
        {
          error:
            'Could not load that sheet as CSV — it likely isn\'t shared as "Anyone with the link ' +
            'can view." Check the sheet\'s sharing settings, or use file upload instead.',
        },
        403
      )
    );
  }

  return withCors(jsonResponse({ csv: body }, 200));
}

function buildPrompt(styleRuns, targetParagraphs) {
  return `You are matching styled sections of a wiki page from an English source to its translation in another language.

The English version has these styled sections. Each has a style label, the paragraph index range it covers in the English version, and the English text for reference:

${JSON.stringify(styleRuns, null, 2)}

The translated version has been split into paragraphs (0-indexed):

${JSON.stringify(targetParagraphs.map((t, i) => ({ index: i, text: t })), null, 2)}

For each style label above, find the paragraph index range [start, end] (inclusive) in the TRANSLATED paragraphs that corresponds to the same content, by meaning. Translators sometimes merge or split paragraphs differently than the English version — do not assume matching paragraph counts or positions. Match by what the content actually says, using distinctive names, numbers, or events as anchors.

If you are not confident about a match, still give your best-guess range but set confidence to "low". Every style label from the input must appear exactly once in your response.

Respond with JSON matching the required schema, and nothing else.`;
}

function buildSubphrasePrompt(items) {
  return `You are matching a specific styled sub-phrase from an English wiki sentence to its equivalent substring in a translated version of the SAME sentence.

For each item below: "context_line" is the full English sentence/line for context. "styled_text" is the exact substring within it that carries special styling (e.g. bold). "target_text" is the SAME sentence, already translated into another language, as one plain unbroken string.

${JSON.stringify(items, null, 2)}

For each item, find the substring within its "target_text" that expresses the same meaning as "styled_text", in the context of the full sentence. Word order and phrasing can differ substantially between languages — match by meaning, not position.

Requirements:
- Your answer's "target_text" field for each item MUST be an EXACT, VERBATIM substring copied from that item's own "target_text" field above — do not paraphrase, re-translate, or alter spacing/punctuation. If you cannot find a confident match, still return your best-guess substring copied verbatim from "target_text" and set confidence to "low".
- Every "id" from the input must appear exactly once in your response.

Respond with JSON matching the required schema, and nothing else.`;
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, x-app-token");
  return new Response(response.body, { status: response.status, headers });
}
