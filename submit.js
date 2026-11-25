// Contact + order submissions. Validates on the server, blocks spam, rate-limits, then
// delivers by email (Resend) and stores a durable copy (Netlify Blobs). A request only
// succeeds if at least one durable channel worked, so nothing is silently lost.
const crypto = require('crypto');
const { load, originOk, corsHeaders, catalog, money } = require('./_shared/config');

const hits = new Map();
function limited(ip, max, windowMs) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(ip, arr); if (hits.size > 5000) hits.clear();
  return arr.length > max;
}
const json = (status, body, origin) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }, body: JSON.stringify(body) });
const line = (v, max) => clean(v, max).replace(/\s+/g, ' ');
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[0-9+()\-.\s]{5,30}$/;

function validate(b) {
  const errors = {}, out = { form: b.form };
  out.name = line(b.name, 80); if (out.name.length < 2) errors.name = 'Please enter your name.';
  out.email = line(b.email, 120).toLowerCase(); if (!EMAIL.test(out.email)) errors.email = 'Please enter a valid email.';
  out.phone = line(b.phone, 30); if (out.phone && !PHONE.test(out.phone)) errors.phone = 'Please enter a valid phone number.';
  if (b.form === 'order') {
    const item = catalog().get(line(b.itemId, 80));
    if (!item) errors.itemId = 'Please choose a valid item.';
    else { out.item = { id: item.id, name: item.name, group: item.groupLabel, price: item.price, billing: item.billing }; }   // price comes from OUR data, never the browser
    out.method = ['card', 'bank', 'mobile'].includes(b.method) ? b.method : 'card';
    out.notes = clean(b.notes, 2000);
  } else if (b.form === 'contact') {
    out.service = line(b.service, 120);
    out.message = clean(b.message, 3000); if (out.message.length < 5) errors.message = 'Please tell us a little about the project.';
    out.intent = line(b.intent, 40);
  } else errors.form = 'Unknown form.';
  return { errors, out };
}

function emailHtml(d, ref) {
  const rows = [['Reference', ref], ['Form', d.form], ['Name', d.name], ['Email', d.email], ['Phone', d.phone || '-']];
  if (d.form === 'order') rows.push(['Item', `${d.item.name} (${d.item.group})`], ['Fixed price', money(d.item.price) + (d.item.billing === 'monthly' ? '/mo' : '')], ['Payment preference', d.method], ['Notes', d.notes || '-']);
  else rows.push(['Service', d.service || '-'], ['Intent', d.intent || '-'], ['Message', d.message]);
  return `<table cellpadding="8" style="font:14px Arial,sans-serif;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#777;vertical-align:top"><b>${esc(k)}</b></td><td>${esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('')}</table>`;
}

async function sendEmail(d, ref) {
  const key = process.env.RESEND_API_KEY; if (!key) return false;
  const site = load().site, to = process.env.SUBMISSION_TO_EMAIL || site.email;
  const from = process.env.SUBMISSION_FROM_EMAIL || 'Fortis Website <onboarding@resend.dev>';
  const subject = d.form === 'order' ? `New order request: ${d.item.name} [${ref}]` : `New project inquiry from ${d.name} [${ref}]`;
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], reply_to: d.email, subject, html: emailHtml(d, ref) }) });
  if (!r.ok) { console.error('resend', r.status, (await r.text()).slice(0, 200)); return false; }
  return true;
}
async function store(d, ref) {
  try {
    const { getStore } = await import('@netlify/blobs');
    await getStore('submissions').setJSON(`${new Date().toISOString().slice(0, 10)}/${ref}`, { ...d, ref, receivedAt: new Date().toISOString() });
    return true;
  } catch (e) { console.error('blobs unavailable:', e.message); return false; }
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, message: 'Method not allowed' }, origin);
  if (!originOk(origin)) return json(403, { ok: false, message: 'Origin not allowed' }, origin);
  if ((event.body || '').length > 12000) return json(413, { ok: false, message: 'Request too large' }, origin);

  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  if (limited(ip, 5, 10 * 60 * 1000)) return json(429, { ok: false, message: 'Too many submissions. Please wait a few minutes and try again.' }, origin);

  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, message: 'Bad request' }, origin); }
  // spam traps: honeypot filled, or form completed impossibly fast. Pretend success so bots learn nothing.
  if (clean(body.website, 200) || (Number(body.elapsed) || 0) < 2500) return json(200, { ok: true, ref: 'FA-' + crypto.randomBytes(3).toString('hex').toUpperCase() }, origin);

  const { errors, out } = validate(body);
  if (Object.keys(errors).length) return json(400, { ok: false, errors, message: Object.values(errors)[0] }, origin);

  const ref = 'FA-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  console.log('SUBMISSION', JSON.stringify({ ref, ...out }));          // always visible in function logs too
  const [mailed, stored] = await Promise.all([sendEmail(out, ref).catch(e => { console.error('mail', e.message); return false; }), store(out, ref)]);
  if (!mailed && !stored) return json(503, { ok: false, message: 'We could not record your request just now. Please email ' + load().site.email + ' directly.' }, origin);
  return json(200, { ok: true, ref }, origin);
};
