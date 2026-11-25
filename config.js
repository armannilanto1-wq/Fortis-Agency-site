// Single loader for data/fortis.json: pricing, site URL, allowed origins and the chat prompt.
// Both the page (at build time) and these functions read the SAME file.
const fs = require('fs');
const path = require('path');

let cached;
function load() {
  if (cached) return cached;
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'data', 'fortis.json'),
    path.join(process.cwd(), 'data', 'fortis.json'),
    '/var/task/data/fortis.json'
  ];
  for (const p of candidates) {
    try { cached = JSON.parse(fs.readFileSync(p, 'utf8')); return cached; } catch (e) { /* try next */ }
  }
  throw new Error('data/fortis.json not found (check included_files in netlify.toml)');
}

const money = n => '$' + n.toLocaleString('en-US');

function allowedOrigins() {
  const d = load();
  const list = new Set([d.site.url, ...(d.site.extraAllowedOrigins || [])].map(u => u.replace(/\/$/, '')));
  [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL].filter(Boolean).forEach(u => list.add(u.replace(/\/$/, '')));
  (process.env.EXTRA_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).forEach(u => list.add(u.replace(/\/$/, '')));
  return list;
}
function originOk(origin) {
  if (!origin) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return allowedOrigins().has(origin.replace(/\/$/, ''));
}
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': originOk(origin) ? origin : load().site.url,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

// every orderable item, flattened: used to validate submissions against the real price list
function catalog() {
  const d = load(), out = new Map();
  d.pricing.categories.forEach(c => c.items.forEach(i => out.set(i.id, { ...i, group: c.id, groupLabel: c.label })));
  d.pricing.packages.forEach(i => out.set(i.id, { ...i, group: 'packages', groupLabel: 'Signature Packages' }));
  d.pricing.retainers.forEach(i => out.set(i.id, { ...i, group: 'retainers', groupLabel: 'Monthly Retainers' }));
  return out;
}

function buildSystemPrompt() {
  const d = load(), p = d.pricing, lines = [];
  lines.push(...d.chat.persona, '');
  lines.push(`CONTACT: ${d.site.email} | ${d.site.phone} | ${d.site.address.line1}, ${d.site.address.line2}`, '');
  lines.push('FOUNDER: ' + d.chat.founderNote, '');
  lines.push(`PRICING (${p.label}). These are FORTIS PRICES in USD:`);
  p.categories.forEach(c => lines.push(`- ${c.label}: ` + c.items.map(i => `${i.name} ${money(i.price)}${i.billing === 'monthly' ? '/mo' : ''}`).join('; ')));
  lines.push('SIGNATURE PACKAGES:');
  p.packages.forEach(k => lines.push(`- ${k.name} ${money(k.price)} (${k.tag}): ${k.includes.join(', ')}`));
  lines.push('MONTHLY RETAINERS:');
  p.retainers.forEach(k => lines.push(`- ${k.name} ${money(k.price)}/mo: ${k.includes.join(', ')}`));
  lines.push('', 'POLICIES:', ...p.policies.map(x => '- ' + x));
  return lines.join('\n');
}

module.exports = { load, originOk, corsHeaders, catalog, buildSystemPrompt, money };
