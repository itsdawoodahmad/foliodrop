const { callAI, stripFences } = require('./_ai');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const pages = req.body && req.body.pages; // [{ page: 1, text: '...' }, ...]
  if (!Array.isArray(pages) || !pages.length) {
    res.status(400).json({ error: 'Missing "pages" array in request body' });
    return;
  }

  const pageBlock = pages
    .map(function (p) { return 'Page ' + p.page + ':\n' + String(p.text || '').slice(0, 400); })
    .join('\n\n')
    .slice(0, 18000);

  const prompt =
    'Below are short text snippets from each page of a PDF, in order. Identify natural split points ' +
    '\u2014 e.g. a new chapter, a new invoice, a new section, or an unrelated topic starting. ' +
    'Respond with ONLY valid JSON (no markdown fences, no commentary) in exactly this shape:\n' +
    '{"splits": [8, 15], "reason": "one short sentence explaining the split points"}\n\n' +
    '"splits" should list the page numbers where a NEW section STARTS (never include page 1). ' +
    'If the document reads as one continuous piece with no clear break, return {"splits": [], "reason": "..."}.\n\n'
    + pageBlock;

  try {
    const { text: raw, source } = await callAI(prompt);
    let parsed;
    try {
      parsed = JSON.parse(stripFences(raw));
    } catch (e) {
      parsed = { splits: [], reason: 'Could not parse a suggestion from the AI response.' };
    }
    const maxPage = pages.length;
    const splits = (Array.isArray(parsed.splits) ? parsed.splits : [])
      .map(Number)
      .filter(function (n) { return Number.isInteger(n) && n > 1 && n <= maxPage; })
      .sort(function (a, b) { return a - b; });

    res.status(200).json({ splits: splits, reason: parsed.reason || '', source: source });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
