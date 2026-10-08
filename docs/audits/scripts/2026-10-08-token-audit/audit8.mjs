import fs from 'node:fs'; import path from 'node:path';
const root = path.join(process.env.HOME, '.claude', 'projects');
const DAYS = Number(process.argv[2] || 7); const since = Date.now() - DAYS * 86400e3;
const price = (m) => /opus|fable|mythos/i.test(m) ? { in: 15, cr: 1.5, cw: 18.75, out: 75 } : /haiku/i.test(m) ? { in: 1, cr: 0.1, cw: 1.25, out: 5 } : { in: 3, cr: 0.3, cw: 3.75, out: 15 };
const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl') && fs.statSync(p).mtimeMs > since) files.push(p); } })(root);
const agg = {}; let tot = 0; const loops = {};
const add = (k, c, n, idle, ctx) => { const r = agg[k] ??= { cost: 0, calls: 0, idleCost: 0, idleCalls: 0, ctx: 0, turns: 0, idleTurns: 0 }; r.cost += c; r.calls += n; r.ctx += ctx; r.turns++; if (idle) { r.idleCost += c; r.idleCalls += n; r.idleTurns++; } };
for (const f of files) {
  const proj = f.slice(root.length + 1).split('/')[0].replace('-Users-dominique-Documents-dev-', '').replace('ai-sdlc-ai-sdlc', 'ai-sdlc');
  const isSub = f.includes('/subagents/') || /agent-/.test(path.basename(f));
  let lines; try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
  let loop = null, agentType = '', turn = null;
  const flush = () => { if (!turn || !turn.calls) return; const idle = turn.noop && turn.calls <= 4; const k = `${proj} | ${isSub ? 'subagent:' + (agentType || '?') : (turn.loop || 'interactive/other')}`; add(k, turn.cost, turn.calls, idle, turn.ctx); tot += turn.cost; turn = null; };
  for (const l of lines) {
    if (!l) continue; let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.agentType && !agentType) agentType = j.agentType;
    if (j.type === 'user') { const c = typeof j.message?.content === 'string' ? j.message.content : JSON.stringify(j.message?.content || ''); const m = c.match(/<command-name>\/?(ai-sdlc:[a-z-]+|loop|schedule)<\/command-name>/) || c.match(/\/ai-sdlc[: ]([a-z-]+)/); if (m) loop = m[1].replace(/^ai-sdlc:/, ''); if (!/tool_result/.test(c.slice(0, 200))) { flush(); turn = { loop, cost: 0, calls: 0, noop: false, ctx: 0 }; } continue; }
    if (j.type !== 'assistant' || !j.message?.usage) continue;
    const t = Date.parse(j.timestamp); if (!(t > since)) continue;
    if (!turn) turn = { loop, cost: 0, calls: 0, noop: false, ctx: 0 };
    const u = j.message.usage, m = j.message.model || '?', p = price(m);
    turn.cost += ((u.input_tokens || 0) * p.in + (u.cache_read_input_tokens || 0) * p.cr + (u.cache_creation_input_tokens || 0) * p.cw + (u.output_tokens || 0) * p.out) / 1e6;
    turn.calls++; turn.ctx += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if ((j.message.content || []).some(b => b.type === 'tool_use' && b.name === 'ScheduleWakeup' && b.input?.noop)) turn.noop = true;
  }
  flush();
}
console.log(`${DAYS}-day: $${tot.toFixed(0)} API-weight. Idle = turns that end in a noop ScheduleWakeup with <=4 calls.`);
console.log('\nPROJECT | LOOP                         cost$ share%  idle$ idle%  turns idleTurns calls avgCtx(k)');
let idleTot = 0; for (const [k, r] of Object.entries(agg).sort((a, b) => b[1].cost - a[1].cost).slice(0, 22)) { idleTot += r.idleCost; console.log(`  ${k.padEnd(44)} ${r.cost.toFixed(0).padStart(6)} ${(100 * r.cost / tot).toFixed(0).padStart(5)} ${r.idleCost.toFixed(0).padStart(6)} ${(100 * r.idleCost / Math.max(r.cost, 1)).toFixed(0).padStart(5)} ${String(r.turns).padStart(6)} ${String(r.idleTurns).padStart(8)} ${String(r.calls).padStart(6)} ${(r.ctx / r.calls / 1000).toFixed(0).padStart(6)}`); }
console.log(`\nIDLE TOTAL (top rows): $${idleTot.toFixed(0)} = ${(100 * idleTot / tot).toFixed(0)}% of 7-day spend`);
