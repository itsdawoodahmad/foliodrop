// Shared helper: tries Groq first (fast, generous free tier), falls back
// to Gemini if Groq is rate-limited/unavailable/not configured. Both keys
// live only in Vercel's server-side environment variables — never sent
// to the browser.
//
// Env vars required (set in Vercel → Settings → Environment Variables):
//   GROQ_API_KEY
//   GEMINI_API_KEY
// The function still works with just one of the two set — it simply
// skips whichever provider has no key.

const GROQ_MODEL = 'openai/gpt-oss-120b';           // check Groq's docs for the current recommended model
const GEMINI_MODEL = 'gemini-3.5-flash';            // check Google AI's docs for the current recommended model

async function tryGroq(prompt) {
  if (!process.env.GROQ_API_KEY) return null;
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.GROQ_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3
    })
  });
  if (!r.ok) return null;
  const data = await r.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return content ? { text: content, source: 'groq' } : null;
}

async function tryGemini(prompt) {
  if (!process.env.GEMINI_API_KEY) return null;
  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent',
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    }
  );
  if (!r.ok) return null;
  const data = await r.json();
  const content = data && data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  return content ? { text: content, source: 'gemini' } : null;
}

// Strips ```json ... ``` fences some models wrap around JSON answers.
function stripFences(s) {
  return String(s).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
}

async function callAI(prompt) {
  let result = null;
  try { result = await tryGroq(prompt); } catch (e) { result = null; }
  if (!result) {
    try { result = await tryGemini(prompt); } catch (e) { result = null; }
  }
  if (!result) {
    throw new Error('AI request failed on both providers. Check that GROQ_API_KEY and/or GEMINI_API_KEY are set in Vercel and haven\u2019t hit their free-tier limit.');
  }
  return result;
}

module.exports = { callAI, stripFences };
