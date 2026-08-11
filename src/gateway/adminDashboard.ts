/**
 * gateway/adminDashboard.ts
 *
 * Serves the admin dashboard's UI (HLD Sec 7.4, 14, 15 — "committee
 * dashboard") as one self-contained HTML page — no build step, no
 * frontend framework, no new heavy dependency, matching this repo's
 * existing "no new dependency for something simple" instinct (see e.g.
 * why intentRouter.ts is a keyword classifier, not a Gemini call). Static
 * markup only; every real action (upload a document, add a resident) is
 * a `fetch()` call against gateway/adminDocumentsRoutes.ts /
 * adminResidentsRoutes.ts's JSON APIs, authenticated the same
 * bearer-JWT way as a script calling those routes directly would be.
 *
 * Auth model: the page itself is served with no server-side session —
 * anyone who knows the URL can *load* it, but every API call it makes
 * needs a valid admin JWT (scripts/mint-admin-token.ts), which the
 * Secretary pastes in once and the page keeps in `localStorage` (never
 * sent anywhere but this app's own `/admin/*` endpoints). This mirrors
 * gateway/adminAuth.ts's deliberate "no invented login flow" design —
 * see that file's own doc comment.
 */
import type { FastifyInstance } from 'fastify';

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI Housing Secretary — Admin Dashboard</title>
<style>
  :root {
    --bg: #f4f6f9;
    --surface: #ffffff;
    --border: #e2e6ec;
    --text: #1c2230;
    --text-muted: #667085;
    --primary: #2456d6;
    --primary-hover: #1c45b0;
    --danger: #d43f3f;
    --danger-hover: #b43333;
    --radius: 10px;
    --shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.08);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 18px 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  header h1 { font-size: 17px; font-weight: 600; margin: 0; }
  header .sub { color: var(--text-muted); font-size: 13px; margin-top: 2px; }
  #logout-btn {
    background: none; border: 1px solid var(--border); color: var(--text-muted);
    padding: 7px 14px; border-radius: var(--radius); cursor: pointer; font-size: 13px;
  }
  #logout-btn:hover { border-color: var(--danger); color: var(--danger); }
  main { max-width: 960px; margin: 0 auto; padding: 28px; }
  nav.tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
  nav.tabs button {
    background: none; border: none; padding: 10px 16px; font-size: 14px; font-weight: 500;
    color: var(--text-muted); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
  }
  nav.tabs button.active { color: var(--primary); border-bottom-color: var(--primary); }
  section.panel {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 22px; margin-bottom: 20px;
  }
  section.panel h2 { font-size: 15px; margin: 0 0 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--text-muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }
  tr:last-child td { border-bottom: none; }
  .empty { color: var(--text-muted); font-style: italic; padding: 14px 0; font-size: 13.5px; }
  form.stack { display: flex; flex-direction: column; gap: 12px; max-width: 480px; }
  label { font-size: 13px; font-weight: 500; color: var(--text-muted); display: block; margin-bottom: 4px; }
  input[type="text"], input[type="tel"], input[type="file"], select {
    width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 7px;
    font-size: 14px; font-family: inherit; background: var(--surface); color: var(--text);
  }
  input:focus, select:focus { outline: 2px solid var(--primary); outline-offset: 1px; }
  button.primary {
    background: var(--primary); color: white; border: none; padding: 9px 18px;
    border-radius: 7px; font-size: 14px; font-weight: 500; cursor: pointer; align-self: flex-start;
  }
  button.primary:hover { background: var(--primary-hover); }
  button.primary:disabled { opacity: 0.6; cursor: default; }
  button.link-danger {
    background: none; border: none; color: var(--danger); cursor: pointer; font-size: 13px; padding: 0;
  }
  button.link-danger:hover { color: var(--danger-hover); text-decoration: underline; }
  .badge {
    display: inline-block; background: #eef1f8; color: #4a5578; font-size: 11.5px;
    padding: 2px 8px; border-radius: 999px; font-weight: 500;
  }
  #banner {
    display: none; padding: 10px 14px; border-radius: 8px; font-size: 13.5px; margin-bottom: 16px;
  }
  #banner.error { display: block; background: #fdecec; color: var(--danger); border: 1px solid #f6c6c6; }
  #banner.success { display: block; background: #eafaf0; color: #1a7f4a; border: 1px solid #bfe8cf; }
  #login-screen {
    max-width: 420px; margin: 12vh auto; background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: var(--shadow); padding: 32px;
  }
  #login-screen h1 { font-size: 18px; margin: 0 0 6px; }
  #login-screen p { color: var(--text-muted); font-size: 13.5px; margin: 0 0 18px; line-height: 1.5; }
  textarea#token-input {
    width: 100%; min-height: 90px; padding: 10px; border: 1px solid var(--border); border-radius: 7px;
    font-family: ui-monospace, monospace; font-size: 12.5px; resize: vertical; margin-bottom: 12px;
  }
  #app { display: none; }
</style>
</head>
<body>

<div id="login-screen">
  <h1>Admin sign-in</h1>
  <p>Paste the admin token you were given (see <code>pnpm admin:mint-token</code> in
  docs/admin-dashboard.md if you're setting this up). It's kept only in this browser.</p>
  <textarea id="token-input" placeholder="eyJhbGciOi..."></textarea>
  <button class="primary" id="login-btn">Continue</button>
  <div id="login-error" style="color:#d43f3f;font-size:13px;margin-top:10px;"></div>
</div>

<div id="app">
  <header>
    <div>
      <h1>AI Housing Secretary</h1>
      <div class="sub">Admin dashboard</div>
    </div>
    <button id="logout-btn">Sign out</button>
  </header>
  <main>
    <div id="banner"></div>
    <nav class="tabs">
      <button data-tab="documents" class="active">Documents</button>
      <button data-tab="residents">Residents</button>
    </nav>

    <section class="panel" data-panel="documents">
      <h2>Society documents</h2>
      <table id="documents-table">
        <thead><tr><th>Title</th><th>Category</th><th>Version</th><th>Updated</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
      <div class="empty" id="documents-empty" style="display:none;">No documents uploaded yet.</div>
    </section>

    <section class="panel">
      <h2>Upload a document</h2>
      <form class="stack" id="upload-form">
        <div>
          <label for="doc-title">Title</label>
          <input type="text" id="doc-title" required placeholder="e.g. Society Bye-Laws 2026" />
        </div>
        <div>
          <label for="doc-category">Category</label>
          <select id="doc-category" required></select>
        </div>
        <div>
          <label for="doc-file">File (.pdf, .md, or .txt)</label>
          <input type="file" id="doc-file" accept=".pdf,.md,.markdown,.txt,application/pdf,text/plain,text/markdown" required />
        </div>
        <button class="primary" type="submit" id="upload-btn">Upload</button>
      </form>
    </section>

    <section class="panel" data-panel="residents" style="display:none;">
      <h2>Residents</h2>
      <table id="residents-table">
        <thead><tr><th>Flat</th><th>Name</th><th>Phone</th><th>Vehicles</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
      <div class="empty" id="residents-empty" style="display:none;">No residents yet.</div>
    </section>

    <section class="panel" data-panel="residents" style="display:none;">
      <h2>Add / update a resident</h2>
      <p style="color:#667085;font-size:12.5px;margin-top:-8px;">Adding a resident with a phone number that already exists updates that resident instead of duplicating them.</p>
      <form class="stack" id="resident-form">
        <div>
          <label for="res-flat">Flat number</label>
          <input type="text" id="res-flat" required placeholder="e.g. A-403" />
        </div>
        <div>
          <label for="res-name">Name</label>
          <input type="text" id="res-name" required placeholder="e.g. Priya Sharma" />
        </div>
        <div>
          <label for="res-phone">Phone (E.164, starts with +)</label>
          <input type="tel" id="res-phone" required placeholder="+919620594287" />
        </div>
        <div>
          <label for="res-vehicles">Vehicles (comma-separated, optional)</label>
          <input type="text" id="res-vehicles" placeholder="MH12AB1234, MH12CD5678" />
        </div>
        <div>
          <label for="res-emergency">Emergency contact (optional)</label>
          <input type="text" id="res-emergency" placeholder="+919000000000" />
        </div>
        <button class="primary" type="submit" id="resident-btn">Save resident</button>
      </form>
    </section>
  </main>
</div>

<script>
(function () {
  'use strict';
  var TOKEN_KEY = 'ai_housing_secretary_admin_token';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  function showBanner(message, kind) {
    var el = document.getElementById('banner');
    el.textContent = message;
    el.className = kind;
    if (kind === 'success') setTimeout(function () { el.className = ''; }, 4000);
  }

  function api(path, options) {
    options = options || {};
    var headers = options.headers || {};
    headers['Authorization'] = 'Bearer ' + getToken();
    return fetch(path, Object.assign({}, options, { headers: headers })).then(function (res) {
      if (res.status === 401) {
        clearToken();
        showLogin('Your token was rejected or has expired — sign in again.');
        throw new Error('unauthorized');
      }
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || ('Request failed (' + res.status + ')'));
        return body;
      });
    });
  }

  function showLogin(errorMessage) {
    document.getElementById('app').style.display = 'none';
    document.getElementById('login-screen').style.display = 'block';
    document.getElementById('login-error').textContent = errorMessage || '';
  }

  function showApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    loadDocuments();
    loadResidents();
  }

  document.getElementById('login-btn').addEventListener('click', function () {
    var value = document.getElementById('token-input').value.trim();
    if (!value) return;
    setToken(value);
    showApp();
  });

  document.getElementById('logout-btn').addEventListener('click', function () {
    clearToken();
    showLogin();
  });

  // Tabs
  var tabButtons = document.querySelectorAll('nav.tabs button');
  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabButtons.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var tab = btn.getAttribute('data-tab');
      document.querySelectorAll('[data-panel]').forEach(function (panel) {
        panel.style.display = panel.getAttribute('data-panel') === tab ? 'block' : 'none';
      });
    });
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var categories = [];

  function loadDocuments() {
    api('/admin/documents').then(function (data) {
      categories = data.categories || [];
      var select = document.getElementById('doc-category');
      select.innerHTML = categories.map(function (c) {
        return '<option value="' + c.id + '">' + escapeHtml(c.label) + '</option>';
      }).join('');

      var tbody = document.querySelector('#documents-table tbody');
      var docs = data.documents || [];
      document.getElementById('documents-empty').style.display = docs.length ? 'none' : 'block';
      tbody.innerHTML = docs.map(function (d) {
        var categoryLabel = (categories.filter(function (c) { return c.id === d.category; })[0] || {}).label || d.category;
        return '<tr>' +
          '<td>' + escapeHtml(d.title) + '</td>' +
          '<td><span class="badge">' + escapeHtml(categoryLabel) + '</span></td>' +
          '<td>v' + d.version + '</td>' +
          '<td>' + new Date(d.uploadedAt).toLocaleDateString() + '</td>' +
          '<td><button class="link-danger" data-delete-doc="' + d.id + '">Remove</button></td>' +
          '</tr>';
      }).join('');

      tbody.querySelectorAll('[data-delete-doc]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!confirm('Remove this document? It will no longer be searchable.')) return;
          api('/admin/documents/' + btn.getAttribute('data-delete-doc'), { method: 'DELETE' })
            .then(function () { showBanner('Document removed.', 'success'); loadDocuments(); })
            .catch(function (err) { showBanner(err.message, 'error'); });
        });
      });
    }).catch(function (err) { if (err.message !== 'unauthorized') showBanner(err.message, 'error'); });
  }

  document.getElementById('upload-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var title = document.getElementById('doc-title').value.trim();
    var category = document.getElementById('doc-category').value;
    var fileInput = document.getElementById('doc-file');
    var file = fileInput.files[0];
    if (!file) { showBanner('Choose a file first.', 'error'); return; }

    var form = new FormData();
    form.append('title', title);
    form.append('category', category);
    form.append('file', file);

    var btn = document.getElementById('upload-btn');
    btn.disabled = true;
    btn.textContent = 'Uploading...';

    api('/admin/documents', { method: 'POST', body: form })
      .then(function () {
        showBanner('"' + title + '" uploaded and indexed.', 'success');
        document.getElementById('upload-form').reset();
        loadDocuments();
      })
      .catch(function (err) { if (err.message !== 'unauthorized') showBanner(err.message, 'error'); })
      .finally(function () { btn.disabled = false; btn.textContent = 'Upload'; });
  });

  function loadResidents() {
    api('/admin/residents').then(function (data) {
      var tbody = document.querySelector('#residents-table tbody');
      var residents = data.residents || [];
      document.getElementById('residents-empty').style.display = residents.length ? 'none' : 'block';
      tbody.innerHTML = residents.map(function (r) {
        return '<tr>' +
          '<td>' + escapeHtml(r.flatNumber) + '</td>' +
          '<td>' + escapeHtml(r.name) + '</td>' +
          '<td>' + escapeHtml(r.phoneE164) + '</td>' +
          '<td>' + escapeHtml((r.vehicles || []).join(', ')) + '</td>' +
          '<td><button class="link-danger" data-delete-res="' + r.id + '">Remove</button></td>' +
          '</tr>';
      }).join('');

      tbody.querySelectorAll('[data-delete-res]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!confirm('Remove this resident?')) return;
          api('/admin/residents/' + btn.getAttribute('data-delete-res'), { method: 'DELETE' })
            .then(function () { showBanner('Resident removed.', 'success'); loadResidents(); })
            .catch(function (err) { showBanner(err.message, 'error'); });
        });
      });
    }).catch(function (err) { if (err.message !== 'unauthorized') showBanner(err.message, 'error'); });
  }

  document.getElementById('resident-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var vehiclesRaw = document.getElementById('res-vehicles').value.trim();
    var emergency = document.getElementById('res-emergency').value.trim();
    var payload = {
      flatNumber: document.getElementById('res-flat').value.trim(),
      name: document.getElementById('res-name').value.trim(),
      phoneE164: document.getElementById('res-phone').value.trim(),
      vehicles: vehiclesRaw ? vehiclesRaw.split(',').map(function (v) { return v.trim(); }).filter(Boolean) : []
    };
    if (emergency) payload.emergencyContact = emergency;

    var btn = document.getElementById('resident-btn');
    btn.disabled = true;

    api('/admin/residents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function () {
        showBanner('Resident saved.', 'success');
        document.getElementById('resident-form').reset();
        loadResidents();
      })
      .catch(function (err) { if (err.message !== 'unauthorized') showBanner(err.message, 'error'); })
      .finally(function () { btn.disabled = false; });
  });

  if (getToken()) { showApp(); } else { showLogin(); }
})();
</script>
</body>
</html>`;

export function registerAdminDashboard(app: FastifyInstance): void {
  app.get('/admin/dashboard', async (_request, reply) => {
    reply.type('text/html').send(DASHBOARD_HTML);
  });
}
