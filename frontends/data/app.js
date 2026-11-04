const config = {
  animals: { title: 'Animals', singular: 'animal', columns: [['name', 'Name'], ['birthDate', 'Birth date'], ['enclosure', 'Enclosure'], ['parent', 'Recorded parent']], fields: [['name', 'Name', 'text', 80], ['birthDate', 'Birth date', 'date'], ['enclosureId', 'Enclosure', 'relation', 'enclosures'], ['parentId', 'Recorded parent (optional)', 'relation', 'animals']] },
  enclosures: { title: 'Enclosures', singular: 'enclosure', columns: [['name', 'Name'], ['habitatType', 'Habitat'], ['areaSqm', 'Area (m²)']], fields: [['name', 'Name', 'text', 100], ['habitatType', 'Habitat', 'habitat'], ['areaSqm', 'Area (m²)', 'number']] },
  employees: { title: 'Employees', singular: 'employee', columns: [['firstName', 'First name'], ['lastName', 'Last name'], ['jobTitle', 'Role'], ['email', 'Email']], fields: [['firstName', 'First name', 'text', 60], ['lastName', 'Last name', 'text', 60], ['jobTitle', 'Job title', 'text', 80], ['email', 'Email', 'email', 254]] },
  checkups: { title: 'Checkups', singular: 'checkup', columns: [['checkedAt', 'Examined at'], ['animal', 'Animal'], ['employee', 'Employee'], ['notes', 'Notes']], fields: [['animalId', 'Animal', 'relation', 'animals'], ['employeeId', 'Employee', 'relation', 'employees'], ['checkedAt', 'Examined at', 'datetime-local'], ['notes', 'Notes', 'textarea', 10000]] },
};
const main = document.querySelector('#main');
const dialog = document.querySelector('#create-dialog');
let generation = 0;
let formVersion = 0;
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const label = record => record.name || [record.firstName, record.lastName].filter(Boolean).join(' ') || `Checkup ${record.id}`;
function state() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const [db, entity, id] = path.split('/');
  return { db: db === 'mongo' ? 'mongo' : 'postgres', entity: config[entity] ? entity : 'animals', id: id ? decodeURIComponent(id) : null, params: new URLSearchParams(query) };
}
function route(db, entity, id = '', params = new URLSearchParams()) {
  return `#${db}/${entity}${id ? `/${encodeURIComponent(id)}` : ''}${params.size ? `?${params}` : ''}`;
}
async function api(db, path, options = {}) {
  const response = await fetch(`/api/${db}/${path}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error([data.error || 'Request failed', ...(data.issues || []).map(issue => `${issue.field}: ${issue.message}`)].join('\n'));
  return data;
}
function relation(entity, record, db) {
  return record ? `<a href="${route(db, entity, record.id)}">${escape(label(record))}<span class="link-arrow">↗</span></a>` : '<span class="muted">—</span>';
}
function value(field, data, db) {
  if (['animal', 'parent', 'enclosure', 'employee'].includes(field)) return relation({ animal: 'animals', parent: 'animals', enclosure: 'enclosures', employee: 'employees' }[field], data, db);
  if (field === 'checkedAt') return escape(new Date(data).toLocaleString());
  if (field === 'areaSqm') return escape(Number(data).toLocaleString());
  if (field === 'habitatType') return `<span class="badge">${escape(data)}</span>`;
  return escape(data ?? '—');
}
function table(entity, items, db) {
  const columns = config[entity].columns;
  return `<div class="table-scroll"><table><thead><tr>${columns.map(([, title]) => `<th>${title}</th>`).join('')}<th><span class="sr-only">Detail</span></th></tr></thead><tbody>${items.map(item => `<tr>${columns.map(([field], index) => `<td class="${field === 'notes' ? 'notes-cell' : ''}">${index === 0 ? `<a class="record-link" href="${route(db, entity, item.id)}">${value(field, item[field], db)}</a>` : value(field, item[field], db)}</td>`).join('')}<td><a class="open-link" aria-label="View ${escape(label(item))}" href="${route(db, entity, item.id)}">→</a></td></tr>`).join('')}</tbody></table></div>`;
}
function heading(entity, title, description = '', action = true) {
  return `<div class="page-heading"><div><h1>${escape(title)}</h1>${description ? `<p>${escape(description)}</p>` : ''}</div>${action ? `<button class="primary" id="new-record">＋ New ${config[entity].singular}</button>` : ''}</div>`;
}
function showError(error, target = main) {
  const box = document.createElement('div'); box.className = 'error'; box.setAttribute('role', 'alert'); box.textContent = error.message;
  target.replaceChildren(box);
}
async function render() {
  const token = ++generation;
  const s = state();
  document.querySelector('#database').value = s.db;
  document.querySelector('#navigation').innerHTML = Object.entries(config).map(([entity, c]) => `<a class="nav-link ${entity === s.entity ? 'active' : ''}" ${entity === s.entity ? 'aria-current="page"' : ''} href="${route(s.db, entity)}">${c.title}</a>`).join('');
  main.innerHTML = '<div class="loading" role="status">Loading collection…</div>';
  try {
    const [stats, data] = await Promise.all([api(s.db, 'stats'), api(s.db, s.id ? `${s.entity}/${encodeURIComponent(s.id)}` : `${s.entity}?${s.params}`)]);
    if (token !== generation) return;
    if (s.id) renderDetail(s, data);
    else {
      main.innerHTML = heading(s.entity, config[s.entity].title) + `<div class="stats">${Object.entries(config).map(([entity, c]) => `<a class="stat ${entity === s.entity ? 'selected' : ''}" href="${route(s.db, entity)}"><span>${c.title}</span><strong>${stats[entity].toLocaleString()}</strong></a>`).join('')}</div><section class="panel"><div class="panel-toolbar"><div><h2>All ${config[s.entity].title.toLowerCase()}</h2><span class="muted">${data.total.toLocaleString()} matching records · ${s.db === 'mongo' ? 'MongoDB' : 'PostgreSQL'}</span></div><form id="search-form" class="search"><input aria-label="Search ${s.entity}" name="q" type="search" placeholder="Search ${s.entity}…" maxlength="200" value="${escape(s.params.get('q') || '')}"><button type="submit">Search</button></form></div>${[...s.params.keys()].some(k => k.endsWith('Id')) ? `<div class="filter-notice">Showing related records <a href="${route(s.db, s.entity)}">Clear filter</a></div>` : ''}${data.items.length ? table(s.entity, data.items, s.db) : '<div class="empty"><h3>No records found</h3><p>Try another search or create the first record in this collection.</p></div>'}<div class="pagination"><span>${data.total ? `${(data.page - 1) * data.limit + 1}–${(data.page - 1) * data.limit + data.items.length} of ${data.total}` : '0 records'}</span><div><button id="previous" ${data.page <= 1 ? 'disabled' : ''}>← Previous</button><span>Page ${data.page}</span><button id="next" ${data.page * data.limit >= data.total ? 'disabled' : ''}>Next →</button></div></div></section>`;
      document.querySelector('#search-form').onsubmit = event => { event.preventDefault(); const params = new URLSearchParams(s.params); params.set('q', new FormData(event.target).get('q')); params.delete('page'); location.hash = route(s.db, s.entity, '', params); };
      for (const [name, delta] of [['previous', -1], ['next', 1]]) document.querySelector(`#${name}`).onclick = () => { const params = new URLSearchParams(s.params); params.set('page', String(data.page + delta)); location.hash = route(s.db, s.entity, '', params); };
    }
    const create = document.querySelector('#new-record');
    if (create) create.onclick = () => openForm(s);
  } catch (error) { if (token === generation) showError(error); }
}
function renderDetail(s, { record, relations }) {
  const c = config[s.entity];
  main.innerHTML = `<a class="back" href="${route(s.db, s.entity)}">← Back to ${c.title.toLowerCase()}</a>` + heading(s.entity, label(record), `Record details · ${s.db === 'mongo' ? 'MongoDB' : 'PostgreSQL'}`, false) + `<div class="record-actions"><button id="edit-record">Edit</button><button id="delete-record" class="danger">Delete</button></div><div id="record-error" role="alert"></div><section class="panel detail-panel"><div class="panel-toolbar"><h2>${c.title === 'Checkups' ? 'Examination' : 'Overview'}</h2><span class="badge">${escape(record.id)}</span></div><dl class="details">${c.columns.map(([field, title]) => `<div><dt>${title}</dt><dd>${value(field, record[field], s.db)}</dd></div>`).join('')}</dl></section>` + Object.entries(relations).map(([key, page]) => {
    const entity = key === 'offspring' ? 'animals' : key;
    const filter = key === 'offspring' ? 'parentId' : s.entity === 'enclosures' ? 'enclosureId' : s.entity === 'employees' ? 'employeeId' : 'animalId';
    const params = new URLSearchParams({ [filter]: s.id });
    return `<section class="panel"><div class="panel-toolbar"><div><h2>${key === 'offspring' ? 'Offspring' : config[entity].title} <span class="count">${page.total}</span></h2><span class="muted">${entity === 'checkups' ? 'Most recent first · complete history available' : 'Related records'}</span></div><a href="${route(s.db, entity, '', params)}">View all →</a></div>${page.items.length ? table(entity, page.items, s.db) : '<div class="empty compact">No related records yet.</div>'}</section>`;
  }).join('') + `<details class="panel raw"><summary>View source record · ${s.db === 'mongo' ? 'embedded document' : 'API representation'}</summary><pre>${escape(JSON.stringify(record, null, 2))}</pre></details>`;
  document.querySelector('#edit-record').onclick = () => openForm(s, record);
  document.querySelector('#delete-record').onclick = async event => {
    const impact = s.entity === 'animals' ? ' All checkups for this animal will also be deleted. Its offspring will remain, with their recorded parent cleared.' : '';
    if (!window.confirm(`Delete ${c.singular} "${label(record)}" from ${s.db === 'mongo' ? 'MongoDB' : 'PostgreSQL'}?${impact} This cannot be undone.`)) return;
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Deleting…';
    try {
      await api(s.db, `${s.entity}/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
      if (location.hash === route(s.db, s.entity, record.id)) location.hash = route(s.db, s.entity);
      notify(`${c.singular[0].toUpperCase() + c.singular.slice(1)} deleted`);
    } catch (error) {
      const target = document.querySelector('#record-error');
      if (target && state().id === record.id && state().db === s.db) showError(error, target);
      button.disabled = false;
      button.textContent = 'Delete';
    }
  };
}
function notify(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 3500);
}
function openForm(s, record = null) {
  const c = config[s.entity];
  const editing = record !== null;
  let saving = false;
  dialog.oncancel = event => { if (saving) event.preventDefault(); };
  const version = ++formVersion;
  dialog.innerHTML = `<form id="create-form"><div class="dialog-heading"><div><p class="muted">${s.db === 'mongo' ? 'MongoDB' : 'PostgreSQL'}</p><h2 id="dialog-title">${editing ? 'Edit' : 'New'} ${c.singular}</h2></div><button type="button" class="icon-button" id="close-dialog" aria-label="Close">×</button></div><div class="form-fields">${c.fields.map(([name, title, type, option]) => {
    const required = name !== 'parentId' ? 'required' : '';
    if (type === 'relation') return `<div class="field"><label for="${name}">${title}</label><input type="search" data-lookup="${name}" data-entity="${option}" aria-label="Search ${title}" placeholder="Search ${option}…" maxlength="200"><select id="${name}" name="${name}" ${required}><option value="">${required ? 'Choose a record' : 'No recorded parent'}</option></select><small id="${name}-hint" class="muted" role="status">Loading options…</small></div>`;
    if (type === 'habitat') return `<div class="field"><label for="${name}">${title}</label><select id="${name}" name="${name}" required>${['Savannah', 'Grassland', 'Coastal', 'Tropical rainforest'].map(v => `<option>${v}</option>`).join('')}</select></div>`;
    if (type === 'textarea') return `<div class="field"><label for="${name}">${title}</label><textarea id="${name}" name="${name}" rows="4" maxlength="${option}" required></textarea></div>`;
    return `<div class="field"><label for="${name}">${title}</label><input id="${name}" name="${name}" type="${type}" ${required} ${typeof option === 'number' ? `maxlength="${option}"` : ''} ${type === 'datetime-local' ? 'step="0.001"' : ''} ${type === 'number' ? 'min="0.01" max="99999999.99" step="0.01"' : ''}></div>`;
  }).join('')}</div><div id="form-error" role="alert"></div><div class="dialog-actions"><button type="button" id="cancel-dialog">Cancel</button><button class="primary" type="submit">${editing ? 'Save changes' : `Create ${c.singular}`}</button></div></form>`;
  const form = dialog.querySelector('#create-form');
  if (record) for (const [name, , type] of c.fields) {
    const control = form.elements.namedItem(name);
    if (type === 'relation') {
      const related = record[{ enclosureId: 'enclosure', parentId: 'parent', animalId: 'animal', employeeId: 'employee' }[name]];
      if (related) control.add(new Option(`${label(related)} (${related.id})`, related.id, true, true));
    } else if (type === 'datetime-local') {
      const date = new Date(record[name]);
      control.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
    } else control.value = record[name] ?? '';
  }
  dialog.showModal();
  dialog.querySelector('#close-dialog').onclick = dialog.querySelector('#cancel-dialog').onclick = () => dialog.close();
  for (const input of dialog.querySelectorAll('[data-lookup]')) {
    let requestVersion = 0, timer;
    const load = async () => {
      const current = ++requestVersion;
      const select = dialog.querySelector(`#${input.dataset.lookup}`);
      const hint = dialog.querySelector(`#${input.dataset.lookup}-hint`);
      try {
        const page = await api(s.db, `${input.dataset.entity}?${new URLSearchParams({ q: input.value, limit: '50' })}`);
        if (current !== requestVersion || version !== formVersion || !dialog.open) return;
        const selected = select.selectedOptions[0];
        const keep = selected?.value && !page.items.some(item => item.id === selected.value) ? selected.outerHTML : '';
        const previous = select.value;
        select.innerHTML = `<option value="">${select.required ? 'Choose a record' : 'No recorded parent'}</option>${keep}${page.items.filter(item => input.dataset.lookup !== 'parentId' || item.id !== record?.id).map(item => `<option value="${escape(item.id)}">${escape(label(item))} (${escape(item.id)})</option>`).join('')}`;
        select.value = previous;
        hint.textContent = page.total ? `${page.total} matches${page.total > 50 ? ' · search to narrow the first 50 results' : ''}` : `No matches. Create ${input.dataset.entity} first if this collection is empty.`;
      } catch (error) { if (version === formVersion && current === requestVersion) hint.textContent = error.message; }
    };
    input.oninput = () => { clearTimeout(timer); ++requestVersion; timer = setTimeout(load, 250); };
    load();
  }
  dialog.querySelector('#create-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.target;
    const data = Object.fromEntries(new FormData(form));
    if ('areaSqm' in data) data.areaSqm = Number(data.areaSqm);
    if ('parentId' in data && !data.parentId) data.parentId = null;
    if ('checkedAt' in data) data.checkedAt = new Date(data.checkedAt).toISOString();
    const buttons = form.querySelectorAll('button');
    saving = true;
    buttons.forEach(button => button.disabled = true);
    const submit = form.querySelector('[type="submit"]'); submit.textContent = 'Saving…';
    try {
      const saved = await api(s.db, editing ? `${s.entity}/${encodeURIComponent(record.id)}` : s.entity, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      dialog.close();
      const hash = route(s.db, s.entity, saved.id);
      if (location.hash === hash) render(); else location.hash = hash;
      notify(`${c.singular[0].toUpperCase() + c.singular.slice(1)} ${editing ? 'updated' : 'created'}`);
    } catch (error) { saving = false; form.querySelector('#form-error').textContent = error.message; buttons.forEach(button => button.disabled = false); submit.textContent = editing ? 'Save changes' : `Create ${c.singular}`; }
  };
}
document.querySelector('#database').onchange = event => { dialog.close(); ++formVersion; const s = state(); location.hash = route(event.target.value, s.entity); };
window.addEventListener('hashchange', () => { if (dialog.open) dialog.close(); ++formVersion; render(); });
if (!location.hash) location.replace('#postgres/animals');
else render();
