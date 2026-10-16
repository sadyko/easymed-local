// Prints the observed cell of every scenario (optionally filtered by id prefix).
import { start, cell } from './helpers.mjs';
import { SCENARIOS } from './scenarios-789.mjs';
const pre = process.argv[2] || '';
for (const sc of SCENARIOS.filter((s) => s.id.startsWith(pre))) {
  const t = await start();
  try {
    const ctx = await sc.run(t);
    console.log(JSON.stringify(sc.id) + ': ' + JSON.stringify(cell(t, ctx.rid, ctx)) + ',');
  } catch (e) { console.log(sc.id, 'ERROR', e.message); }
  finally { t.close(); }
}
