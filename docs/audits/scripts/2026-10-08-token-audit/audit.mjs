import fs from 'node:fs';
import path from 'node:path';
const root = path.join(process.env.HOME, '.claude', 'projects');
const since = Date.now() - 24 * 3600 * 1000;
const price = (m) =>
  /opus|fable|mythos/i.test(m)
    ? { in: 15, cr: 1.5, cw: 18.75, out: 75 }
    : /haiku/i.test(m)
      ? { in: 1, cr: 0.1, cw: 1.25, out: 5 }
      : { in: 3, cr: 0.3, cw: 3.75, out: 15 };
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl') && fs.statSync(p).mtimeMs > since) files.push(p);
  }
})(root);
const sessions = new Map();
for (const f of files) {
  const proj = f
    .slice(root.length + 1)
    .split('/')[0]
    .replace('-Users-dominique-Documents-dev-', '');
  const isSub = f.includes('/subagents/') || /agent-/.test(path.basename(f));
  let firstUser = '',
    lines;
  try {
    lines = fs.readFileSync(f, 'utf8').split('\n');
  } catch {
    continue;
  }
  const s = {
    file: f,
    proj,
    isSub,
    role: null,
    model: '',
    calls: 0,
    ctxSum: 0,
    ctxMax: 0,
    out: 0,
    cost: 0,
    resets: 0,
    first: null,
    last: null,
    cw: 0,
    cr: 0,
    inp: 0,
    agentType: '',
  };
  let prevCtx = 0;
  for (const l of lines) {
    if (!l) continue;
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    if (j.type === 'user' && !firstUser) {
      const c = j.message?.content;
      firstUser =
        typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join(' ') : '';
    }
    if (j.agentType && !s.agentType) s.agentType = j.agentType;
    if (j.type !== 'assistant' || !j.message?.usage) continue;
    const t = Date.parse(j.timestamp);
    if (!(t > since)) continue;
    const u = j.message.usage,
      m = j.message.model || '';
    const ctx =
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
    const p = price(m);
    s.calls++;
    s.ctxSum += ctx;
    s.ctxMax = Math.max(s.ctxMax, ctx);
    s.out += u.output_tokens || 0;
    s.model = m;
    s.inp += u.input_tokens || 0;
    s.cr += u.cache_read_input_tokens || 0;
    s.cw += u.cache_creation_input_tokens || 0;
    s.cost +=
      ((u.input_tokens || 0) * p.in +
        (u.cache_read_input_tokens || 0) * p.cr +
        (u.cache_creation_input_tokens || 0) * p.cw +
        (u.output_tokens || 0) * p.out) /
      1e6;
    if (prevCtx > 50000 && ctx < prevCtx * 0.4) s.resets++;
    prevCtx = ctx;
    s.first = s.first ?? t;
    s.last = t;
  }
  if (!s.calls) continue;
  const fu = firstUser.slice(0, 400);
  s.role = s.isSub
    ? `subagent:${s.agentType || 'unknown'}`
    : /ai-sdlc:executor|\/ai-sdlc executor|executor-(alpha|beta|gamma|delta|epsilon)/.test(fu)
      ? 'executor'
      : /operator-dispatch/.test(fu)
        ? 'dispatch'
        : /ai-sdlc:planner|\/ai-sdlc planner/.test(fu)
          ? 'planner'
          : /ai-sdlc:execute\b|\/ai-sdlc execute/.test(fu)
            ? 'execute'
            : 'other';
  s.hint = fu.replace(/\s+/g, ' ').slice(0, 70);
  sessions.set(f, s);
}
const all = [...sessions.values()];
const tot = all.reduce((a, s) => a + s.cost, 0);
const byRole = {};
for (const s of all) {
  const k = `${s.proj} | ${s.role}`;
  const r = (byRole[k] ??= { sessions: 0, calls: 0, ctxSum: 0, cost: 0, out: 0, resets: 0 });
  r.sessions++;
  r.calls += s.calls;
  r.ctxSum += s.ctxSum;
  r.cost += s.cost;
  r.out += s.out;
  r.resets += s.resets;
}
console.log(
  `24h window. sessions=${all.length} calls=${all.reduce((a, s) => a + s.calls, 0)} API-weight $${tot.toFixed(0)}`,
);
console.log('\nBY PROJECT | ROLE   sessions calls avgCtx(k) cost$ share% out(k) resets');
for (const [k, r] of Object.entries(byRole).sort((a, b) => b[1].cost - a[1].cost))
  console.log(
    `${k.padEnd(44)} ${String(r.sessions).padStart(4)} ${String(r.calls).padStart(6)} ${(r.ctxSum / r.calls / 1000).toFixed(0).padStart(8)} ${r.cost.toFixed(0).padStart(6)} ${((100 * r.cost) / tot).toFixed(0).padStart(5)} ${(r.out / 1000).toFixed(0).padStart(6)} ${String(r.resets).padStart(6)}`,
  );
console.log(
  '\nTOP 20 SESSIONS   cost$ share% calls avgCtx(k) peak(k) cw(k) model resets span(h)  role hint',
);
for (const s of all.sort((a, b) => b.cost - a.cost).slice(0, 20))
  console.log(
    `${s.cost.toFixed(0).padStart(5)} ${((100 * s.cost) / tot).toFixed(0).padStart(5)} ${String(s.calls).padStart(5)} ${(s.ctxSum / s.calls / 1000).toFixed(0).padStart(8)} ${(s.ctxMax / 1000).toFixed(0).padStart(7)} ${(s.cw / 1000).toFixed(0).padStart(6)} ${s.model.replace('claude-', '').slice(0, 14).padEnd(14)} ${String(s.resets).padStart(3)} ${((s.last - s.first) / 3.6e6).toFixed(1).padStart(6)}  ${s.proj.slice(0, 14).padEnd(14)} ${s.role.padEnd(22)} ${s.hint}`,
  );
const cw = all.reduce((a, s) => a + s.cw, 0),
  cr = all.reduce((a, s) => a + s.cr, 0),
  inp = all.reduce((a, s) => a + s.inp, 0);
console.log(
  `\nTOKENS: cache_write=${(cw / 1e6).toFixed(1)}M cache_read=${(cr / 1e6).toFixed(1)}M uncached_in=${(inp / 1e6).toFixed(1)}M`,
);
