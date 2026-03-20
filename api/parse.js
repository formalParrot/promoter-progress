export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { pdfBase64, prompt } = req.body;
    if (!pdfBase64 || !prompt) {
      res.status(400).json({ error: 'Missing pdfBase64 or prompt' });
      return;
    }

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) {
      res.status(500).json({ error: 'API key not configured' });
      return;
    }

    async function callGemini(promptText) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
                { text: promptText }
              ]
            }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 65536,
              response_mime_type: 'application/json'
            }
          })
        }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Gemini API error');
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    function cleanAndParse(raw) {
      raw = raw.replace(/```json|```/g, '').trim();
      const js = raw.indexOf('{');
      const je = raw.lastIndexOf('}');
      if (js === -1 || je === -1) throw new Error('No JSON found');
      return JSON.parse(raw.slice(js, je + 1));
    }

    // ── Call 1: Intro + task metadata + questions/options (no long texts) ─────
    const prompt1 = `Parse this exam PDF. Return ONLY valid JSON. DO NOT include article texts or passages in this response - only extract questions and short content.
{
  "hasIntro": true,
  "introText": "full intro page text",
  "tasks": [
    {"task":1,"type":"listening","points":8,"question_count":8,"instructions":"instruction text","questions":["q1","q2"],"options":[["A. opt","B. opt","C. opt","D. opt"]]},
    {"task":2,"type":"match","points":8,"question_count":8,"instructions":"instruction text","questions":["statement1","statement2"],"passages":{"A":"paragraph A","B":"paragraph B","C":"paragraph C","D":"paragraph D","E":"paragraph E","F":"paragraph F"}},
    {"task":3,"type":"reading","points":8,"question_count":8,"instructions":"instruction text","text":"","questions":["q1"],"options":[["A. opt","B. opt","C. opt","D. opt"]]},
    {"task":4,"type":"gapfill4","points":12,"question_count":12,"instructions":"instruction text","text":"","word_bank":{"A":"word","B":"word","C":"word"}},
    {"task":5,"type":"gapfill5","points":12,"question_count":12,"instructions":"instruction text","text":"","choices":[["A. word","B. word","C. word","D. word"]]},
    {"task":6,"type":"dialogue","points":6,"question_count":6,"instructions":"instruction text","dialogue":["Speaker: line","Speaker: ...(1)"],"options":{"A":"sentence","B":"sentence"}},
    {"task":7,"type":"essay","points":16,"instructions":"instruction text","prompt":"essay question"}
  ]
}
RULES: Preserve Georgian text. Extract all tasks. Leave "text" field empty for reading/gapfill tasks - we will fetch those separately. Detect task type from content.`;

    // ── Call 2: Long texts only (reading passage, gapfill articles) ───────────
    const prompt2 = `From this exam PDF, extract ONLY the long article/passage texts for each task. Return ONLY valid JSON:
{
  "texts": {
    "task3": "COMPLETE reading passage word for word",
    "task4": "COMPLETE article text with gap markers as ......(1) ......(2) etc at exact positions",
    "task5": "COMPLETE article text with gap markers as ......(1) ......(2) etc at exact positions"
  }
}
RULES: Copy text EXACTLY word for word. Do not summarize. Preserve Georgian text exactly. Include gap markers at their exact positions for gapfill tasks.`;

    // Run both calls in parallel
    const [raw1, raw2] = await Promise.all([
      callGemini(prompt1),
      callGemini(prompt2)
    ]);

    const parsed1 = cleanAndParse(raw1);
    let parsed2;
    try {
      parsed2 = cleanAndParse(raw2);
    } catch(e) {
      parsed2 = { texts: {} };
    }

    // Merge texts into the main result
    if (parsed2.texts && parsed1.tasks) {
      for (let i = 0; i < parsed1.tasks.length; i++) {
        const t = parsed1.tasks[i];
        const key = 'task' + t.task;
        if (parsed2.texts[key]) {
          t.text = parsed2.texts[key];
        }
      }
    }

    res.status(200).json({ text: JSON.stringify(parsed1) });

  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
