import fs from 'node:fs';
import path from 'node:path';
const root = path.join(process.env.HOME, '.claude', 'projects');
const DAYS = Number(process.argv[2] || 7);
const since = Date.now() - DAYS * 86400e3;
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
const byCmd = {},
  byModel = {},
  byDay = {};
let tot = 0;
const idle = { cost: 0, calls: 0 };
for (const f of files) {
  const proj = f
    .slice(root.length + 1)
    .split('/')[0]
    .replace('-Users-dominique-Documents-dev-', '')
    .replace('ai-sdlc-ai-sdlc', 'ai-sdlc');
  const isSub = f.includes('/subagents/') || /agent-/.test(path.basename(f));
  let lines;
  try {
    lines = fs.readFileSync(f, 'utf8').split('\n');
  } catch {
    continue;
  }
  let cmd = null,
    agentType = '',
    prevWasWake = false;
  for (const l of lines) {
    if (!l) continue;
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    if (j.agentType && !agentType) agentType = j.agentType;
    if (j.type === 'user') {
      const c = JSON.stringify(j.message?.content || '');
      const m = c.match(/<command-name>\/?([^<]+)<\/command-name>/);
      if (m) cmd = m[1].trim();
      prevWasWake = /ScheduleWakeup fired|wake-?up|\[loop\]|<loop/i.test(c.slice(0, 400));
      continue;
    }
    if (j.type !== 'assistant' || !j.message?.usage) continue;
    const t = Date.parse(j.timestamp);
    if (!(t > since)) continue;
    const u = j.message.usage,
      m = j.message.model || '?',
      p = price(m);
    const cost =
      ((u.input_tokens || 0) * p.in +
        (u.cache_read_input_tokens || 0) * p.cr +
        (u.cache_creation_input_tokens || 0) * p.cw +
        (u.output_tokens || 0) * p.out) /
      1e6;
    const ctx =
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
    const key = isSub ? `subagent:${agentType || 'unknown'}` : cmd || 'no-command';
    const k2 = `${proj} | ${key}`;
    const r = (byCmd[k2] ??= { cost: 0, calls: 0, ctx: 0 });
    r.cost += cost;
    r.calls++;
    r.ctx += ctx;
    const mm = (byModel[m.replace('claude-', '')] ??= { cost: 0, calls: 0 });
    mm.cost += cost;
    mm.calls++;
    const d = new Date(t).toISOString().slice(0, 10);
    byDay[d] = (byDay[d] || 0) + cost;
    const hasWake = (j.message.content || []).some(
      (b) => b.type === 'tool_use' && b.name === 'ScheduleWakeup' && b.input?.noop,
    );
    if (hasWake || prevWasWake) {
      idle.cost += cost;
      idle.calls++;
    }
    tot += cost;
  }
}
console.log(
  `${DAYS}-day window: API-weight $${tot.toFixed(0)}; idle-wake calls (noop wakeups + the call after a wake) $${idle.cost.toFixed(0)} (${((100 * idle.cost) / tot).toFixed(0)}%) over ${idle.calls} calls`,
);
console.log('\nBY DAY');
for (const [d, c] of Object.entries(byDay).sort()) console.log(`  ${d}  $${c.toFixed(0)}`);
console.log('\nBY MODEL');
for (const [m, r] of Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost))
  console.log(
    `  ${m.padEnd(16)} $${r.cost.toFixed(0).padStart(6)}  ${String(r.calls).padStart(6)} calls`,
  );
console.log('\nBY PROJECT | COMMAND (top 25)   cost$ share% calls avgCtx(k)');
for (const [k, r] of Object.entries(byCmd)
  .sort((a, b) => b[1].cost - a[1].cost)
  .slice(0, 25))
  console.log(
    `  ${k.padEnd(52)} ${r.cost.toFixed(0).padStart(6)} ${((100 * r.cost) / tot).toFixed(0).padStart(5)} ${String(r.calls).padStart(6)} ${(r.ctx / r.calls / 1000).toFixed(0).padStart(6)}`,
  );
