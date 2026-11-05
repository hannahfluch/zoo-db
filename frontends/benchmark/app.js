const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const names = { postgres: 'PostgreSQL', mongo: 'MongoDB' };
const ms = value => Number.isFinite(value) ? `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })} ms` : '—';
const operationTitle = row => row.queryId === 'insert' ? `Insert ${row.recordsPerEntity.toLocaleString()} per entity` : queries.find(query => query.id === row.queryId)?.title || row.queryId;
let queries = [], jobs = [], busy = false, polling = null;
let comparisonMetric = 'operationMs', comparisonStatistic = 'avg';
const statistics = { avg: 'Mean', med: 'Median', 'p(95)': 'p95', 'p(99)': 'p99', min: 'Minimum', max: 'Maximum' };
function pairedResults(results) {
  const pairs = new Map();
  for (const row of results) {
    if (!pairs.has(row.queryId)) pairs.set(row.queryId, { title: operationTitle(row) });
    pairs.get(row.queryId)[row.database] = row;
  }
  return [...pairs.values()];
}
function timingCell(database, value, maximum, faster) {
  if (!Number.isFinite(value)) return `<td class="timing-cell muted" data-label="${names[database]}">—</td>`;
  const width = maximum > 0 ? Math.min(100, value / maximum * 100) : 0;
  return `<td class="timing-cell ${faster ? 'faster' : ''}" data-label="${names[database]}"><strong>${ms(value)}</strong><div class="timing-track" aria-hidden="true"><span class="timing-bar ${database}" style="width:${width}%"></span></div></td>`;
}
function databaseComparison(results) {
  return `<div class="scroll"><table class="comparison-table"><thead><tr><th>Operation</th><th><span class="legend-dot postgres"></span>PostgreSQL</th><th><span class="legend-dot mongo"></span>MongoDB</th><th>Faster in this run</th></tr></thead><tbody>${pairedResults(results).map(pair => {
    const postgres = pair.postgres?.[comparisonMetric]?.[comparisonStatistic];
    const mongo = pair.mongo?.[comparisonMetric]?.[comparisonStatistic];
    const complete = Number.isFinite(postgres) && Number.isFinite(mongo);
    const tied = complete && Math.abs(postgres - mongo) < 0.0005;
    const maximum = Math.max(Number.isFinite(postgres) ? postgres : 0, Number.isFinite(mongo) ? mongo : 0);
    let difference = '<span class="muted">Both databases needed</span>';
    if (complete) {
      if (tied) difference = '<span class="muted">Equal at displayed precision</span>';
      else {
        const faster = postgres < mongo ? 'PostgreSQL' : 'MongoDB';
        const minimum = Math.min(postgres, mongo);
        const ratio = minimum > 0 ? ` · ${(maximum / minimum).toFixed(2)}×` : '';
        difference = `<strong>${faster}</strong><span class="difference">${ms(Math.abs(postgres - mongo))} less${ratio}</span>`;
      }
    }
    return `<tr><th scope="row">${escape(pair.title)}</th>${timingCell('postgres', postgres, maximum, complete && !tied && postgres < mongo)}${timingCell('mongo', mongo, maximum, complete && !tied && mongo < postgres)}<td class="difference-cell">${difference}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
async function api(path, body) {
  const response = await fetch(`/api/benchmark/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await response.json();
  if (!response.ok) throw new Error([data.error || 'Request failed', ...(data.issues || []).map(issue => `${issue.field}: ${issue.message}`)].join('\n'));
  return data;
}
function fail(error) { const box = document.querySelector('#error'); box.textContent = error.message; box.hidden = false; }
function lock(value) { busy = value; document.querySelectorAll('[data-action]').forEach(button => button.disabled = value); }
function renderHistory() {
  document.querySelector('#history').innerHTML = jobs.length ? `<div class="scroll"><table><thead><tr><th>Started</th><th>Operation</th><th>Status</th><th>Total runtime</th><th></th></tr></thead><tbody>${jobs.map(job => `<tr><td>${escape(new Date(job.startedAt).toLocaleString())}</td><td>${escape(job.action)}</td><td>${escape(job.status)}</td><td>${ms(job.durationMs)}</td><td><button data-job="${job.id}">View result</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No runs recorded.</p>';
  document.querySelectorAll('[data-job]').forEach(button => button.onclick = () => { renderJob(jobs.find(job => job.id === button.dataset.job)); document.querySelector('#job-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
}
function renderJob(job) {
  document.querySelector('#job-panel').hidden = false;
  document.querySelector('#job-title').textContent = `${job.action} · ${job.status}`;
  document.querySelector('#job-progress').textContent = `${job.progress}${job.durationMs !== undefined ? ` · ${ms(job.durationMs)} total` : ''}`;
  const result = job.result || {};
  let html = job.error ? `<div class="error">${escape(job.error)}<p>Inspect the recorded operations below for any completed writes.</p></div>` : '';
  if (result.generationMs !== undefined) html += `<p class="muted">Data generation: ${ms(result.generationMs)} · Planner statistics: ${ms(result.analyzeMs)}</p>`;
  if (job.action === 'custom') html += '<p class="muted">Raw query results · embedded-copy maintenance is bypassed.</p><div class="custom-results">';
  for (const operation of result.operations || []) {
    html += `<div class="operation"><h3>${names[operation.database]}</h3>`;
    if (operation.queryId) {
      const custom = operation.queryId === 'custom';
      html += `<p>${operation.rows.toLocaleString()} ${custom ? 'rows / documents' : operation.queryId.startsWith('find') ? 'rows / documents returned' : 'rows / documents matched'} · Database: <strong>${ms(operation.databaseMs)}</strong>${custom ? '' : ` · Embedded sync: ${ms(operation.syncMs)}`} · Total: ${ms(operation.totalMs)}</p><p class="muted">${custom ? `Command: ${escape(operation.command)} · Transaction ${operation.committed ? 'committed' : 'rolled back'}.` : operation.committed ? 'Changes committed.' : 'No changes kept.'}${operation.modified !== null ? ` MongoDB modified ${operation.modified} documents.` : ''}${custom ? '' : ` · Benchmark index ${operation.indexEnabled ? 'on' : 'off'}`}</p>`;
      if (custom) html += `<details><summary>Executed query</summary><pre>${escape(result.request[operation.database === 'postgres' ? 'sql' : 'mongo'])}</pre></details>`;
      if (operation.preview.length) html += `<details><summary>Result preview (${operation.preview.length})</summary><pre>${escape(JSON.stringify(operation.preview, null, 2))}</pre></details>`;
      const cell = document.querySelector(`[data-result="${operation.queryId}-${operation.database}"]`);
      if (cell) cell.textContent = `${ms(operation.databaseMs)} database · ${ms(operation.totalMs)} total · ${operation.rows.toLocaleString()} rows`;
    } else html += `<p><strong>${ms(operation.durationMs)}</strong>${operation.totalRecords ? ` · ${operation.recordsPerEntity.toLocaleString()} per entity / ${operation.totalRecords.toLocaleString()} total records` : ''}${operation.enabled !== undefined ? ` · Benchmark index ${operation.enabled ? 'enabled' : 'disabled'}` : ''}</p>`;
    html += '</div>';
  }
  if (job.action === 'custom') html += '</div>';
  if (result.phases?.some(phase => phase.results?.length)) {
    html += `<div class="comparison-controls"><h3>PostgreSQL vs MongoDB</h3><div class="actions"><label>Timing<select id="comparison-metric"><option value="operationMs" ${comparisonMetric === 'operationMs' ? 'selected' : ''}>Full operation</option><option value="databaseMs" ${comparisonMetric === 'databaseMs' ? 'selected' : ''}>Database calls only</option></select></label><label>Statistic<select id="comparison-statistic">${Object.entries(statistics).map(([value, title]) => `<option value="${value}" ${comparisonStatistic === value ? 'selected' : ''}>${title}</option>`).join('')}</select></label></div></div><p class="muted comparison-note">${comparisonMetric === 'operationMs' ? 'Includes transaction handling, data preparation and embedded maintenance; inserts also include generation.' : 'Measures driver calls and result consumption; query embedded-maintenance time is excluded.'} Lower is faster. Each pair of bars has its own scale.</p>`;
  }
  for (const phase of result.phases || []) {
    html += `<h3>${phase.indexed ? 'With' : 'Without'} benchmark index</h3><p class="muted">Index setup: ${ms((phase.indexOperations || []).reduce((sum, operation) => sum + operation.durationMs, 0))} · Planner statistics: ${ms(phase.analyzeMs)} · Warm-up: ${ms(phase.warmupMs)}</p>`;
    if (phase.results?.length) html += databaseComparison(phase.results) + `<details><summary>Detailed k6 statistics</summary><div class="scroll"><table><thead><tr><th>Database</th><th>Operation</th><th>DB mean</th><th>DB p95</th><th>DB min</th><th>DB max</th><th>Generation mean</th><th>Operation mean</th></tr></thead><tbody>${phase.results.map(row => `<tr><td>${names[row.database]}</td><td>${escape(operationTitle(row))}</td><td>${ms(row.databaseMs?.avg)}</td><td>${ms(row.databaseMs?.['p(95)'])}</td><td>${ms(row.databaseMs?.min)}</td><td>${ms(row.databaseMs?.max)}</td><td>${ms(row.generationMs?.avg)}</td><td>${ms(row.operationMs?.avg)}</td></tr>`).join('')}</tbody></table></div></details>`;
    const metrics = phase.summary?.metrics;
    if (metrics) html += `<p>HTTP requests: ${metrics.http_reqs?.values.count || 0} · HTTP mean: ${ms(metrics.http_req_duration?.values.avg)} · HTTP p95: ${ms(metrics.http_req_duration?.values['p(95)'])} · Failure rate: ${((metrics.http_req_failed?.values.rate || 0) * 100).toFixed(2)}%</p>`;
    if (phase.log) html += `<details><summary>k6 output</summary><pre>${escape(phase.log)}</pre></details>`;
  }
  if (result.phases?.length === 2 && result.phases.every(phase => phase.results?.length)) {
    const without = result.phases.find(phase => !phase.indexed), withIndex = result.phases.find(phase => phase.indexed);
    html += `<details><summary>Index comparison · database mean</summary><div class="scroll"><table><thead><tr><th>Database</th><th>Operation</th><th>Without index (mean)</th><th>With index (mean)</th><th>Without / with</th></tr></thead><tbody>${without.results.map(row => {
      const indexed = withIndex.results.find(other => other.database === row.database && other.queryId === row.queryId);
      const ratio = indexed?.databaseMs?.avg > 0 ? `${(row.databaseMs.avg / indexed.databaseMs.avg).toFixed(2)}×` : '—';
      return `<tr><td>${names[row.database]}</td><td>${escape(operationTitle(row))}</td><td>${ms(row.databaseMs?.avg)}</td><td>${ms(indexed?.databaseMs?.avg)}</td><td>${ratio}</td></tr>`;
    }).join('')}</tbody></table></div></details>`;
  }
  html += `<details><summary>Full result JSON</summary><pre>${escape(JSON.stringify(job, null, 2))}</pre></details>`;
  document.querySelector('#job-result').innerHTML = html;
  const metric = document.querySelector('#comparison-metric');
  if (metric) metric.onchange = event => { comparisonMetric = event.target.value; renderJob(job); document.querySelector('#comparison-metric').focus(); };
  const statistic = document.querySelector('#comparison-statistic');
  if (statistic) statistic.onchange = event => { comparisonStatistic = event.target.value; renderJob(job); document.querySelector('#comparison-statistic').focus(); };
}
async function refresh() {
  const state = await api('state');
  document.querySelector('#state').innerHTML = `<div class="scroll"><table><thead><tr><th>Database</th><th>Enclosures</th><th>Employees</th><th>Animals</th><th>Checkups</th><th>Benchmark index</th></tr></thead><tbody>${Object.keys(names).map(database => `<tr><td>${names[database]}</td>${['enclosures', 'employees', 'animals', 'checkups'].map(entity => `<td>${state.counts[database][entity].toLocaleString()}</td>`).join('')}<td>${state.indexes[database] ? 'On' : 'Off'}</td></tr>`).join('')}</tbody></table></div>`;
  document.querySelector('#k6-status').textContent = state.k6Available ? 'k6 is available.' : 'k6 is unavailable. Start the backend container to use it.';
  lock(!!state.active);
  jobs = await api('jobs'); renderHistory();
  if (state.active && !polling) watch(state.active.id);
}
function watch(id) {
  if (polling) clearTimeout(polling);
  const tick = async () => {
    try {
      const job = await api(`jobs/${id}`);
      jobs = [job, ...jobs.filter(existing => existing.id !== id)].slice(0, 50);
      renderJob(job); renderHistory();
      if (job.status === 'running') polling = setTimeout(tick, 1000);
      else { polling = null; lock(false); await refresh(); }
    } catch (error) { polling = null; lock(false); fail(error); }
  };
  polling = setTimeout(tick, 100);
}
async function start(body) {
  if (busy) return;
  document.querySelector('#error').hidden = true;
  lock(true);
  try { const job = await api('jobs', body); renderJob(job); watch(job.id); }
  catch (error) { lock(false); fail(error); }
}
function renderQueries() {
  document.querySelector('#queries').innerHTML = queries.map(query => `<article class="panel query"><div class="section-header"><h3>${escape(query.title)}</h3><button data-both="${query.id}" data-action>Run both</button></div><div class="code-pair">${Object.keys(names).map(database => `<div><div class="section-header"><strong>${names[database]}</strong><button data-query="${query.id}" data-db="${database}" data-action>Run</button></div><pre><code>${escape(database === 'postgres' ? query.sql : query.mongo)}</code></pre><p class="muted" data-result="${query.id}-${database}">Not run yet.</p></div>`).join('')}</div></article>`).join('');
  const run = (target, queryId) => {
    const commit = document.querySelector('#commit-mode').value === 'commit';
    if (commit && queries.find(query => query.id === queryId).kind !== 'find' && !window.confirm(`Apply this ${queryId} operation to ${target === 'both' ? 'both databases' : names[target]}? Changes will be kept.`)) return;
    start({ action: 'query', target, queryId, commit });
  };
  document.querySelectorAll('[data-query]').forEach(button => button.onclick = () => run(button.dataset.db, button.dataset.query));
  document.querySelectorAll('[data-both]').forEach(button => button.onclick = () => run('both', button.dataset.both));
}
function setupEditors() {
  const sql = document.querySelector('#custom-sql'), mongo = document.querySelector('#custom-mongo');
  sql.value = 'SELECT * FROM checkups LIMIT 25;';
  mongo.value = 'db.checkups.find({}).limit(25)';
  try {
    const drafts = JSON.parse(localStorage.getItem('zoo-query-drafts') || '{}');
    if (typeof drafts.sql === 'string') sql.value = drafts.sql;
    if (typeof drafts.mongo === 'string') mongo.value = drafts.mongo;
  } catch {}
  const save = () => { try { localStorage.setItem('zoo-query-drafts', JSON.stringify({ sql: sql.value, mongo: mongo.value })); } catch {} };
  sql.oninput = mongo.oninput = save;
  document.querySelector('#custom-preset').innerHTML += queries.map(query => `<option value="${query.id}">${escape(query.title)}</option>`).join('');
  document.querySelector('#load-custom-preset').onclick = () => {
    const query = queries.find(query => query.id === document.querySelector('#custom-preset').value);
    if (query) { sql.value = query.sql; mongo.value = query.mongo; save(); }
  };
  const run = async target => {
    const commit = document.querySelector('#custom-commit-mode').value === 'commit';
    if (commit && !window.confirm(`Commit the raw query to ${target === 'both' ? 'both databases' : names[target]}? Embedded copies are not synchronized for raw MongoDB writes.`)) return;
    const body = { action: 'custom', target, commit, ...(target !== 'mongo' ? { sql: sql.value } : {}), ...(target !== 'postgres' ? { mongo: mongo.value } : {}) };
    await start(body);
    document.querySelector('#job-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  for (const target of ['postgres', 'mongo', 'both']) document.querySelector(`#run-custom-${target}`).onclick = () => run(target);
  for (const [editor, target] of [[sql, 'postgres'], [mongo, 'mongo']]) editor.onkeydown = event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); document.querySelector(`#run-custom-${target}`).click(); }
  };
}
document.querySelector('#refresh').onclick = () => { if (!busy) refresh().catch(fail); };
document.querySelector('#insert-form').onsubmit = event => { event.preventDefault(); const fields = Object.fromEntries(new FormData(event.target)); start({ action: 'insert', target: fields.target, count: Number(fields.count), seed: Number(fields.seed) }); };
document.querySelector('#suite-form').onsubmit = event => { event.preventDefault(); const fields = Object.fromEntries(new FormData(event.target)); start({ action: 'suite', target: fields.target, indexes: fields.indexes, iterations: Number(fields.iterations), vus: Number(fields.vus), workload: fields.workload, insertCount: Number(fields.insertCount), seed: Number(fields.seed) }); };
for (const [id, enabled] of [['indexes-on', true], ['indexes-off', false]]) document.querySelector(`#${id}`).onclick = () => start({ action: 'indexes', target: document.querySelector('#index-target').value, enabled });
document.querySelector('#reset').onclick = () => { if (window.confirm('Reset both databases? All animals, enclosures, employees and checkups will be deleted. This cannot be undone.')) start({ action: 'reset', confirm: 'RESET BOTH DATABASES' }); };
document.querySelector('#download').onclick = () => {
  const blob = new Blob([JSON.stringify(jobs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `zoo-benchmarks-${new Date().toISOString().replaceAll(':', '-')}.json`; link.click(); URL.revokeObjectURL(url);
};
try { queries = (await api('catalog')).queries; renderQueries(); setupEditors(); await refresh(); } catch (error) { fail(error); }
