const { callAI, stripFences } = require('./_ai');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const text = req.body && req.body.text;
  if (!text || !String(text).trim()) {
    res.status(400).json({ error: 'Missing "text" in request body' });
    return;
  }

  const prompt =
    'You are analyzing text extracted from a PDF document. Respond with ONLY valid JSON ' +
    '(no markdown fences, no commentary) in exactly this shape:\n' +
    '{"summary": ["point 1", "point 2", "point 3"], "filename": "short-descriptive-name"}\n\n' +
    '- "summary": 3 to 6 short bullet points capturing the key content, in your own words.\n' +
    '- "filename": a short, descriptive, lowercase, hyphenated filename with no extension and no spaces ' +
    '(max 6 words), based on the document\'s actual content.\n\n' +
    'Document text:\n' + String(text).slice(0, 18000);

  try {
    const { text: raw, source } = await callAI(prompt);
    let parsed;
    try {
      parsed = JSON.parse(stripFences(raw));
    } catch (e) {
      parsed = { summary: [raw.trim()], filename: 'document' };
    }
    const summary = Array.isArray(parsed.summary) && parsed.summary.length
      ? parsed.summary.map(String)
      : [String(parsed.summary || raw).trim()];
    const filename = String(parsed.filename || 'document')
      .toLowerCase().replace(/[^a-z0-9\-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';

    res.status(200).json({ summary: summary, filename: filename, source: source });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
