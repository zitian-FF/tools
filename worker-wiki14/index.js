// wiki14 Gemini proxy — Cloudflare Worker
//
// This worker does exactly one job: when the static site's deterministic
// paragraph-matching can't align a translated paragraph range to an EN
// styled section (paragraph counts don't match), it asks Gemini to resolve
// the range and hands back JSON. The Gemini API key lives only here, as a
// Worker secret — it is never sent to or visible in the browser.
//
// Deploy:
//   wrangler secret put GEMINI_API_KEY
//   wrangler secret put APP_TOKEN        (any random string you invent)
//   wrangler deploy
//
// Then set ALLOWED_ORIGIN below to your GitHub Pages origin, and put the
// same APP_TOKEN value into site/app.js (see the CONFIG block there).

const ALLOWED_ORIGIN = "https://YOUR-GITHUB-USERNAME.github.io"; // TODO: set this

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
    // burn your Gemini quota. Pair with Cloudflare rate-limiting rules if
    // this ever becomes a real concern.
    if (request.headers.get("x-app-token") !== env.APP_TOKEN) {
      return withCors(new Response("Unauthorized", { status: 401 }));
    }

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
  },
};

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
