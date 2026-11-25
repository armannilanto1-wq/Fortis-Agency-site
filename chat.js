// Fortis chat assistant. The prompt and the prices are built here from data/fortis.json;
// the browser only ever sends the visitor's messages. Key stays in ANTHROPIC_API_KEY.
const { load, originOk, corsHeaders, buildSystemPrompt } = require('./_shared/config');

const hits = new Map(); // per-IP, per warm instance (best effort)
function limited(ip, max, windowMs) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > max;
}
const json = (status, body, origin) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' }, origin);
  if (!originOk(origin)) return json(403, { error: 'Origin not allowed' }, origin);

  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  if (limited(ip, 20, 60000)) return json(429, { error: 'Too many messages. Please wait a minute.' }, origin);
  if (!process.env.ANTHROPIC_API_KEY) return json(503, { error: 'The assistant is not configured yet. Please use the contact form.' }, origin);
  if ((event.body || '').length > 20000) return json(413, { error: 'Message too large' }, origin);

  let cfg; try { cfg = load().chat; } catch (e) { console.error(e); return json(500, { error: 'Configuration error' }, origin); }
  let msgs;
  try { msgs = JSON.parse(event.body || '{}').messages; } catch (e) { return json(400, { error: 'Bad request' }, origin); }
  if (!Array.isArray(msgs) || !msgs.length) return json(400, { error: 'No messages' }, origin);
  msgs = msgs.slice(-cfg.maxMessages)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, cfg.maxChars) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return json(400, { error: 'Last message must come from the visitor' }, origin);

  try {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || cfg.model, max_tokens: cfg.maxTokens, system: buildSystemPrompt(), messages: msgs })
    });
    clearTimeout(to);
    if (!r.ok) { console.error('anthropic', r.status, (await r.text()).slice(0, 300)); return json(502, { error: 'The assistant is unavailable right now. Please use the contact form.' }, origin); }
    const data = await r.json();
    const reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').replace(/\s*[—–]\s*/g, ', ').trim();
    return json(200, { reply: reply || 'Sorry, I could not answer that. Please use the contact form.' }, origin);
  } catch (e) {
    console.error('chat error', e.name);
    return json(502, { error: 'The assistant is unavailable right now. Please use the contact form.' }, origin);
  }
};
