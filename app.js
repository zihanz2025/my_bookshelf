/* =========================================================
   My Bookshelf — Application Logic
   - Google Books API search (API key)
   - Google OAuth 2.0 for My Google Books shelves import
   - Visual bookshelf, drag-drop arrangement
   - localStorage persistence, import/export
   ========================================================= */

// ---------- Storage Keys ----------
const STORAGE_KEY = 'my_bookshelf_data_v1';
const API_KEY_STORAGE = 'my_bookshelf_api_key';
const OAUTH_CLIENT_STORAGE = 'my_bookshelf_oauth_client_id';
const OAUTH_TOKEN_STORAGE = 'my_bookshelf_oauth_token';
const BOOKS_SCOPE = 'https://www.googleapis.com/auth/books';

// Default credentials — bake in yours so it works out of the box.
// localStorage values override these (users can still swap in their own keys via ⚙️ Settings).
const DEFAULT_API_KEY = 'AIzaSyB3m6NN9EbrMtqGsHk1BHeaayP4M_9f40A';
const DEFAULT_OAUTH_CLIENT_ID = '226996063447-sqjj0hnvp1fqmr0ml0hpfvi5vltr59bd.apps.googleusercontent.com';

// ---------- State ----------
let state = loadState();
if (!state) {
  // Not persisted yet: syncFromServer() decides whether to seed the server file
  state = {
    shelfRows: 4,
    shelfCols: 1,
    shelfCount: 4,
    shelves: ['Shelf 1', 'Shelf 2', 'Shelf 3', 'Shelf 4'],
    books: [],
  };
}
normalizeLayout();

// Older saves only stored a flat shelf count — treat it as a single column
function normalizeLayout() {
  if (!state.shelfRows || !state.shelfCols) {
    state.shelfRows = Math.max(1, state.shelfCount || 4);
    state.shelfCols = 1;
  }
  state.shelfRows = Math.min(6, Math.max(1, parseInt(state.shelfRows, 10) || 1));
  state.shelfCols = Math.min(6, Math.max(1, parseInt(state.shelfCols, 10) || 1));
  state.shelfCount = state.shelfRows * state.shelfCols;
}

let googleApiKey = localStorage.getItem(API_KEY_STORAGE) || DEFAULT_API_KEY;
let oauthClientId = localStorage.getItem(OAUTH_CLIENT_STORAGE) || DEFAULT_OAUTH_CLIENT_ID;
let oauthToken = null; // { access_token, expires_at }
let arrangeMode = true;
let currentDragBookId = null;

// ---------- DOM ----------
const els = {};
function cacheDom() {
  Object.assign(els, {
    // Header
    btnSettings: document.getElementById('btn-api-key'), // button id was renamed
    btnExport: document.getElementById('btn-export'),
    btnImport: document.getElementById('btn-import'),
    importFile: document.getElementById('import-file'),

    // Search
    searchInput: document.getElementById('search-input'),
    searchBtn: document.getElementById('search-btn'),
    searchResults: document.getElementById('search-results'),

    // OAuth
    oauthStatus: document.getElementById('oauth-status'),
    oauthPrompt: document.getElementById('oauth-prompt'),
    oauthSignin: document.getElementById('oauth-signin'),
    oauthBody: document.getElementById('oauth-body'),
    oauthShelves: document.getElementById('oauth-shelves'),

    // Bookshelf
    shelfRows: document.getElementById('shelf-rows'),
    shelfCols: document.getElementById('shelf-cols'),
    shelfTotal: document.getElementById('shelf-total'),
    applyShelves: document.getElementById('apply-shelves'),
    bookshelf: document.getElementById('bookshelf'),
    modeArrange: document.getElementById('mode-arrange'),
    modeView: document.getElementById('mode-view'),
    stats: document.getElementById('stats'),

    // Book detail modal
    modal: document.getElementById('modal'),
    modalClose: document.getElementById('modal-close'),
    modalBody: document.getElementById('modal-body'),

    // Settings modal
    settingsModal: document.getElementById('settings-modal'),
    settingsClose: document.getElementById('settings-close'),
    apiKeyInput: document.getElementById('api-key-input'),
    apiKeySave: document.getElementById('api-key-save'),
    apiKeyClear: document.getElementById('api-key-clear'),
    apiKeyStatus: document.getElementById('api-key-status'),
    oauthClientId: document.getElementById('oauth-client-id'),
    oauthClientSave: document.getElementById('oauth-client-save'),
    oauthClientClear: document.getElementById('oauth-client-clear'),
    oauthClientStatus: document.getElementById('oauth-client-status'),
    currentOrigin: document.getElementById('current-origin'),

    // Toast
    toast: document.getElementById('toast'),
  });
}

// ---------- Persistence ----------
// Books are written to bookshelf.json through the local server (server.py),
// with localStorage kept as an instant cache / offline fallback.
const API_STATE_URL = '/api/state';
let saveTimer = null;

function saveState(opts = {}) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save state:', e);
  }

  clearTimeout(saveTimer);
  const push = () => {
    fetch(API_STATE_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
      keepalive: true,
    }).catch(() => { /* server not running — localStorage still has it */ });
  };
  if (opts.immediate) push();
  else saveTimer = setTimeout(push, 250);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// Returns the server copy, null when the file does not exist yet,
// or undefined when the API is unreachable (opened via file:// or a plain static server).
async function fetchServerState() {
  try {
    const res = await fetch(API_STATE_URL, { cache: 'no-store' });
    if (!res.ok) return undefined;
    const data = await res.json();
    return data == null ? null : data;
  } catch {
    return undefined;
  }
}

async function syncFromServer() {
  const serverState = await fetchServerState();
  if (serverState === undefined) return; // no API available — keep localStorage data

  if (serverState) {
    state = serverState;
    normalizeLayout();
  } else {
    // First run against the server: seed bookshelf.json from what we have
    saveState({ immediate: true });
  }

  els.shelfRows.value = state.shelfRows;
  els.shelfCols.value = state.shelfCols;
  updateShelfHint();
}

// ---------- Toast ----------
function toast(msg, type = '') {
  els.toast.textContent = msg;
  els.toast.className = 'toast ' + type;
  els.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), 2400);
}

// =========================================================
// PART 1 — Public Google Books API Search (API key)
// =========================================================

async function searchBooks(query) {
  if (!query.trim()) return [];
  const params = new URLSearchParams({ q: query, maxResults: '15' });
  if (googleApiKey) params.set('key', googleApiKey);

  const url = `https://www.googleapis.com/books/v1/volumes?${params.toString()}`;
  try {
    const res = await fetch(url);
    if (res.status === 429) {
      toast('Rate limited (429). Add a free API key via ⚙️ Settings.', 'error');
      return [];
    }
    if (res.status === 403) {
      toast('Forbidden (403). API key may be invalid.', 'error');
      return [];
    }
    if (!res.ok) {
      toast(`Search failed (${res.status}). Try again or add an API key.`, 'error');
      return [];
    }
    const data = await res.json();
    return (data.items || []).map(parseBookItem);
  } catch (err) {
    console.error(err);
    toast('Network error. Check your connection.', 'error');
    return [];
  }
}

function parseBookItem(item) {
  const v = item.volumeInfo || {};
  const imgLinks = v.imageLinks || {};
  // Prefer the 2x cover (imageLinks.small) so the blurred spine texture isn't muddy
  const thumbnail = (imgLinks.small || imgLinks.thumbnail || imgLinks.smallThumbnail || '').replace(/^http:/, 'https:');
  return {
    googleId: item.id,
    title: v.title || 'Untitled',
    authors: v.authors || ['Unknown Author'],
    publisher: v.publisher || '',
    publishedDate: v.publishedDate || '',
    description: v.description || '',
    thumbnail,
    pageCount: v.pageCount || 0,
    dimensions: v.dimensions || null,
    categories: v.categories || [],
    infoLink: v.infoLink || '',
  };
}

async function doSearch() {
  const q = els.searchInput.value;
  els.searchResults.innerHTML = '<div style="padding:10px;color:#888;">Searching...</div>';
  const results = await searchBooks(q);
  renderSearchResults(results);
}

function renderSearchResults(results) {
  if (!results.length) {
    els.searchResults.innerHTML = '<div style="padding:10px;color:#888;">No books found. Try another search.</div>';
    return;
  }
  const existingIds = new Set(state.books.map((b) => b.googleId));
  els.searchResults.innerHTML = '';
  results.forEach((book) => {
    const card = document.createElement('div');
    card.className = 'search-result-card';

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (book.thumbnail) {
      const img = document.createElement('img');
      img.src = book.thumbnail;
      img.alt = book.title;
      thumb.appendChild(img);
    } else {
      thumb.textContent = '📖';
    }

    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = book.title;
    const author = document.createElement('div');
    author.className = 'author';
    author.textContent = book.authors.join(', ');
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-add add-btn';
    const already = existingIds.has(book.googleId);
    addBtn.textContent = already ? '✓ Added' : '+ Add to shelf';
    addBtn.disabled = already;
    addBtn.addEventListener('click', () => addBook(book));
    info.append(title, author, addBtn);
    card.append(thumb, info);
    els.searchResults.appendChild(card);
  });
}

// =========================================================
// PART 2 — OAuth 2.0 with Google Identity Services
// =========================================================

// Wait for GIS library to be ready
function waitForGis(maxWaitMs = 8000) {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve(window.google);
    let waited = 0;
    const interval = setInterval(() => {
      waited += 100;
      if (window.google?.accounts?.oauth2) {
        clearInterval(interval);
        resolve(window.google);
      } else if (waited >= maxWaitMs) {
        clearInterval(interval);
        reject(new Error('Google Identity Services failed to load'));
      }
    }, 100);
  });
}

function saveOAuthToken(accessToken, expiresInSec) {
  oauthToken = {
    access_token: accessToken,
    expires_at: Date.now() + (expiresInSec || 3600) * 1000 - 60_000, // 1 min buffer
  };
  localStorage.setItem(OAUTH_TOKEN_STORAGE, JSON.stringify(oauthToken));
}

function loadOAuthToken() {
  try {
    const raw = localStorage.getItem(OAUTH_TOKEN_STORAGE);
    if (!raw) return null;
    const tok = JSON.parse(raw);
    if (tok.expires_at > Date.now()) return tok;
    localStorage.removeItem(OAUTH_TOKEN_STORAGE);
    return null;
  } catch { return null; }
}

function isOAuthConnected() {
  return !!oauthToken && oauthToken.expires_at > Date.now();
}

async function signInWithGoogle() {
  if (!oauthClientId) {
    toast('Set your OAuth Client ID in ⚙️ Settings first', 'error');
    openSettings();
    return;
  }

  try {
    await waitForGis();
  } catch {
    toast('Google sign-in script failed to load. Check your connection.', 'error');
    return;
  }

  console.log('[OAuth] Initiating sign-in with Client ID:', oauthClientId);
  const client = window.google.accounts.oauth2.initTokenClient({
    client_id: oauthClientId,
    scope: BOOKS_SCOPE,
    callback: async (response) => {
      console.log('[OAuth] callback response:', response);
      if (!response?.access_token) {
        toast('Sign-in was cancelled or failed.', 'error');
        renderOAuthStatus();
        return;
      }
      saveOAuthToken(response.access_token, response.expires_in);
      toast('Connected to Google Books!', 'success');
      renderOAuthStatus();
      await fetchAndRenderGoogleShelves();
    },
    error_callback: (err) => {
      console.error('[OAuth] error_callback fired:', err);
      toast('Google sign-in error: ' + (err?.error_description || err?.error || 'unknown'), 'error');
      renderOAuthStatus();
    },
    prompt: 'consent',
  });

  client.requestAccessToken();
}

function signOutGoogle() {
  if (oauthToken?.access_token && window.google?.accounts?.oauth2?.revoke) {
    window.google.accounts.oauth2.revoke(oauthToken.access_token);
  }
  localStorage.removeItem(OAUTH_TOKEN_STORAGE);
  oauthToken = null;
  toast('Signed out', 'success');
  renderOAuthStatus();
}

async function fetchGoogleShelves() {
  if (!isOAuthConnected()) return { shelves: [], error: null };
  try {
    const res = await fetch('https://www.googleapis.com/books/v1/mylibrary/bookshelves', {
      headers: { Authorization: `Bearer ${oauthToken.access_token}` },
    });
    console.log('[API] mylibrary/bookshelves response:', res.status);
    const body = await res.json().catch(() => ({}));
    console.log('[API] response body:', body);
    if (res.status === 401 || res.status === 403) {
      const msg = body?.error?.message || 'Token expired';
      toast('Google error (' + res.status + '): ' + msg, 'error');
      signOutGoogle();
      return { shelves: [], error: msg };
    }
    if (!res.ok) {
      const msg = body?.error?.message || `HTTP ${res.status}`;
      toast('Google Books error: ' + msg, 'error');
      return { shelves: [], error: msg };
    }
    return { shelves: body.items || [], error: null };
  } catch (err) {
    console.error('Fetch shelves error:', err);
    toast('Network error fetching Google shelves', 'error');
    return { shelves: [], error: String(err) };
  }
}

async function fetchGoogleShelvesVolumes(shelfId) {
  if (!isOAuthConnected()) return [];
  try {
    const url = `https://www.googleapis.com/books/v1/mylibrary/bookshelves/${shelfId}/volumes?maxResults=40`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${oauthToken.access_token}` },
    });
    if (res.status === 401 || res.status === 403) {
      toast('Google token expired. Please sign in again.', 'error');
      signOutGoogle();
      return [];
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast('Error loading volumes: ' + (body?.error?.message || `HTTP ${res.status}`), 'error');
      return [];
    }
    const data = await res.json();
    return (data.items || []).map(parseBookItem);
  } catch (err) {
    console.error('Fetch volumes error:', err);
    toast('Failed to fetch volumes', 'error');
    return [];
  }
}

async function fetchAndRenderGoogleShelves() {
  const result = await fetchGoogleShelves();
  renderGoogleShelves(result.shelves, result.error);
}

function renderGoogleShelves(shelves, fetchError) {
  els.oauthShelves.innerHTML = '';
  els.oauthShelves.classList.remove('hidden');

  // Refresh button at top
  const refreshRow = document.createElement('div');
  refreshRow.style.cssText = 'margin-bottom:6px;text-align:right;';
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'oauth-refresh-btn';
  refreshBtn.textContent = '↻ Refresh';
  refreshBtn.addEventListener('click', fetchAndRenderGoogleShelves);
  refreshRow.appendChild(refreshBtn);
  els.oauthShelves.appendChild(refreshRow);

  if (fetchError) {
    const errBox = document.createElement('div');
    errBox.style.cssText = 'padding:10px;background:#fde8e8;border-radius:6px;color:#b04040;font-size:0.78px;';
    errBox.style.fontSize = '0.78rem';
    errBox.textContent = 'Error loading shelves: ' + fetchError;
    els.oauthShelves.appendChild(errBox);
    return;
  }

  // Sort: shelves with books first, then empty
  const populated = shelves.filter((s) => (s.volumeCount || 0) > 0);
  const empty = shelves.filter((s) => (s.volumeCount || 0) === 0);

  // Info banner if everything is empty
  if (populated.length === 0) {
    const infoBox = document.createElement('div');
    infoBox.style.cssText = 'padding:10px;background:#fff6e6;border-radius:6px;font-size:0.78rem;color:#6b5d48;line-height:1.5;margin-bottom:8px;';
    infoBox.innerHTML = `
      Your Google Books shelves are empty. To populate them:<br>
      1. Go to <a href="https://books.google.com" target="_blank" rel="noopener">books.google.com</a><br>
      2. Sign in with this same Google account<br>
      3. Search for a book → click the heart ❤️ to add it to "Favorites"
      or "Want to read"<br>
      4. Come back here and click <b>↻ Refresh</b>
    `;
    els.oauthShelves.appendChild(infoBox);
  }

  // Show populated shelves prominently
  populated.forEach((shelf) => {
    els.oauthShelves.appendChild(buildShelfItem(shelf));
  });

  // Show empty default shelves in a collapsible "Default shelves" section
  if (empty.length > 0) {
    const emptySection = document.createElement('details');
    emptySection.open = populated.length > 0; // auto-expand only if we have other content
    emptySection.style.cssText = 'margin-top:8px;font-size:0.75rem;';

    const emptySummary = document.createElement('summary');
    emptySummary.style.cssText = 'cursor:pointer;color:#6b5d48;padding:4px 0;';
    emptySummary.textContent = `Default shelves (${empty.length}, all empty)`;
    emptySection.appendChild(emptySummary);

    const emptyList = document.createElement('div');
    emptyList.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:4px;';
    empty.forEach((shelf) => {
      const item = buildShelfItem(shelf);
      item.style.opacity = '0.65';
      emptyList.appendChild(item);
    });
    emptySection.appendChild(emptyList);
    els.oauthShelves.appendChild(emptySection);
  }
}

function buildShelfItem(shelf) {
  const item = document.createElement('div');
  item.className = 'oauth-shelf-item';
  item.dataset.shelfId = shelf.id;

  const name = document.createElement('div');
  name.className = 'shelf-name';
  name.textContent = shelf.title || 'Shelf';
  name.title = shelf.title || 'Shelf';

  const count = document.createElement('span');
  count.className = 'shelf-count';
  count.textContent = `${shelf.volumeCount || 0}`;

  const actions = document.createElement('div');
  actions.className = 'shelf-actions';

  const expandBtn = document.createElement('button');
  expandBtn.className = 'oauth-import-btn';
  expandBtn.textContent = 'View';
  expandBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await expandGoogleShelf(shelf.id, name);
  });

  actions.appendChild(expandBtn);
  item.append(name, count, actions);
  return item;
}

async function expandGoogleShelf(shelfId, nameEl) {
  // Toggle state
  const existing = els.oauthShelves.querySelector(`.oauth-shelf-expanded[data-shelf="${shelfId}"]`);
  if (existing) {
    existing.remove();
    return;
  }

  nameEl.innerHTML += ' <span style="font-size:0.68rem;color:#888;">(loading...)</span>';
  const volumes = await fetchGoogleShelvesVolumes(shelfId);

  // Remove loading hint
  nameEl.textContent = nameEl.textContent.replace(' (loading...)', '');

  const expand = document.createElement('div');
  expand.className = 'oauth-shelf-expanded';
  expand.dataset.shelf = shelfId;

  if (!volumes.length) {
    expand.innerHTML = '<div style="padding:8px;color:#888;font-size:0.78rem;">This shelf is empty.</div>';
  } else {
    // Quick import all button
    const importAllRow = document.createElement('div');
    importAllRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px;';
    const importAll = document.createElement('button');
    importAll.className = 'oauth-import-btn';
    importAll.style.cssText = 'font-size:0.72rem;padding:4px 10px;background:var(--success);';
    importAll.textContent = `Add all ${volumes.length} to local shelf`;
    importAll.addEventListener('click', () => {
      volumes.forEach((v) => addBook(v));
      toast(`Imported ${volumes.length} books`, 'success');
    });
    importAllRow.appendChild(importAll);
    expand.appendChild(importAllRow);

    volumes.forEach((book) => {
      const card = document.createElement('div');
      card.className = 'search-result-card';
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      if (book.thumbnail) {
        const img = document.createElement('img');
        img.src = book.thumbnail;
        thumb.appendChild(img);
      } else {
        thumb.textContent = '📖';
      }
      const info = document.createElement('div');
      info.className = 'info';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = book.title;
      const author = document.createElement('div');
      author.className = 'author';
      author.textContent = book.authors.join(', ');
      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-add add-btn';
      const existingIds = new Set(state.books.map((b) => b.googleId));
      addBtn.textContent = existingIds.has(book.googleId) ? '✓ Added' : '+ Add';
      addBtn.disabled = existingIds.has(book.googleId);
      addBtn.addEventListener('click', () => addBook(book));
      info.append(title, author, addBtn);
      card.append(thumb, info);
      expand.appendChild(card);
    });
  }

  els.oauthShelves.appendChild(expand);
}

function renderOAuthStatus() {
  if (isOAuthConnected()) {
    els.oauthStatus.textContent = '● Connected';
    els.oauthStatus.className = 'oauth-status connected';

    els.oauthPrompt.textContent = 'Your Google Books shelves:';
    if (els.oauthSignin && els.oauthSignin.parentNode) els.oauthSignin.remove();
    els.oauthShelves.classList.remove('hidden');

    if (!els.oauthBody.querySelector('.oauth-signout')) {
      const signout = document.createElement('button');
      signout.className = 'oauth-signout';
      signout.textContent = 'Sign out';
      signout.addEventListener('click', signOutGoogle);
      els.oauthBody.appendChild(signout);
    }

    fetchAndRenderGoogleShelves();
  } else {
    els.oauthStatus.textContent = '● Not connected';
    els.oauthStatus.className = 'oauth-status disconnected';

    els.oauthPrompt.textContent = 'Connect your Google account to import books you\'ve saved to books.google.com.';
    els.oauthShelves.classList.add('hidden');

    // Ensure sign-in button is present
    if (!els.oauthBody.querySelector('#oauth-signin')) {
      const btn = document.createElement('button');
      btn.id = 'oauth-signin';
      btn.className = 'btn btn-primary';
      btn.textContent = '🔑 Sign in with Google';
      btn.addEventListener('click', signInWithGoogle);
      els.oauthBody.appendChild(btn);
    }
  }
}

// =========================================================
// PART 3 — Local Bookshelf (drag-drop, arrange, render)
// =========================================================

function addBook(apiBook) {
  const counts = new Array(state.shelfCount).fill(0);
  state.books.forEach((b) => {
    if (b.shelfIndex >= 0 && b.shelfIndex < state.shelfCount)
      counts[b.shelfIndex]++;
  });
  let targetShelf = 0, min = Infinity;
  counts.forEach((c, i) => { if (c < min) { min = c; targetShelf = i; } });

  const newBook = {
    id: crypto.randomUUID(),
    googleId: apiBook.googleId,
    title: apiBook.title,
    authors: apiBook.authors,
    thumbnail: apiBook.thumbnail,
    description: apiBook.description,
    publisher: apiBook.publisher,
    publishedDate: apiBook.publishedDate,
    pageCount: apiBook.pageCount,
    dimensions: apiBook.dimensions || null,
    shelfIndex: targetShelf,
    order: state.books.filter((b) => b.shelfIndex === targetShelf).length,
    hue: Math.floor(Math.random() * 360),
  };

  state.books.push(newBook);
  saveState();
  toast(`Added "${newBook.title}"`, 'success');

  renderBookshelf();
  updateStats();

  // List responses often omit physical dimensions — fetch the single volume to enrich
  enrichBookDetails(newBook);

  // If search input still has text, refresh button states
  if (els.searchInput.value.trim()) doSearch();
  // Also refresh OAuth shelf expand states if open
  refreshGoogleShelfButtons();
}

// Search responses rarely include volumeInfo.dimensions, so look up the
// individual volume (GET /volumes/{id}) and merge the extra details in.
async function enrichBookDetails(book) {
  if (!book.googleId || book.googleId.startsWith('extracted-')) return;
  if (book.dimensions && book.dimensions.height) return;

  try {
    const keyParam = googleApiKey ? `?key=${encodeURIComponent(googleApiKey)}` : '';
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(book.googleId)}${keyParam}`);
    if (!res.ok) return;
    const data = await res.json();
    const v = data.volumeInfo || {};

    const target = state.books.find((b) => b.id === book.id);
    if (!target) return;

    let changed = false;
    let sizeChanged = false;
    if (v.dimensions && (v.dimensions.height || v.dimensions.thickness)) {
      target.dimensions = v.dimensions;
      changed = true;
      sizeChanged = true;
    }
    if (!target.pageCount && v.pageCount) {
      target.pageCount = v.pageCount;
      changed = true;
    }
    if (!target.description && v.description) {
      target.description = v.description;
      changed = true;
    }
    // Remember the lookup so we don't retry volumes Google has no dimensions for
    if (!target.dimEnriched) {
      target.dimEnriched = true;
      changed = true;
    }

    if (changed) {
      saveState();
      if (sizeChanged) {
        renderBookshelf();
        updateStats();
      }
    }
  } catch (err) {
    console.warn('Could not enrich volume details:', err);
  }
}

// One-time lookup for books added before dimension enrichment existed
async function backfillDimensions() {
  const pending = state.books.filter(
    (b) => !(b.dimensions && b.dimensions.height) && !b.dimEnriched &&
      b.googleId && !b.googleId.startsWith('extracted-')
  );
  for (const b of pending) {
    await enrichBookDetails(b);
    await new Promise((r) => setTimeout(r, 120));
  }
}

function refreshGoogleShelfButtons() {
  const existingIds = new Set(state.books.map((b) => b.googleId));
  els.oauthShelves?.querySelectorAll('.btn-add').forEach((btn) => {
    const card = btn.closest('.search-result-card');
    if (!card) return;
    // Find the title text to match
    const titleEl = card.querySelector('.title');
    const titleText = titleEl?.textContent || '';
    // Best we can do without googleId on the expand cards: just keep existing state
    // This is fine — the user won't double-add common titles often
  });
}

function renderBookshelf() {
  while (state.shelves.length < state.shelfCount) {
    state.shelves.push(`Shelf ${state.shelves.length + 1}`);
  }
  state.shelves.length = state.shelfCount;
  els.bookshelf.innerHTML = '';
  els.bookshelf.dataset.cols = String(state.shelfCols || 1);

  for (let i = 0; i < state.shelfCount; i++) {
    const shelfEl = document.createElement('div');
    shelfEl.className = 'shelf';
    shelfEl.dataset.shelf = i;

    const label = document.createElement('div');
    label.className = 'shelf-label';
    label.textContent = state.shelves[i] || `Shelf ${i + 1}`;

    const booksContainer = document.createElement('div');
    booksContainer.className = 'shelf-books';
    booksContainer.dataset.shelf = i;

    const shelfBooks = state.books
      .filter((b) => b.shelfIndex === i)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    if (!shelfBooks.length) {
      const empty = document.createElement('div');
      empty.className = 'shelf-empty-hint';
      empty.textContent = arrangeMode
        ? 'Drag books here from other shelves, or add new books from the left panel.'
        : 'This shelf is empty.';
      booksContainer.appendChild(empty);
    }
    shelfBooks.forEach((book) => booksContainer.appendChild(createBookElement(book)));

    shelfEl.append(label, booksContainer);
    els.bookshelf.appendChild(shelfEl);
    setupShelfDnD(shelfEl, booksContainer);
  }
}

// Convert dimension strings like "24.00 cm" / "240 mm" / "9.5 in" to centimeters
function parseCm(str) {
  if (!str) return null;
  const m = String(str).match(/([\d.]+)\s*(mm|cm|in)?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 'cm').toLowerCase();
  if (unit === 'mm') n /= 10;
  else if (unit === 'in') n *= 2.54;
  return n;
}

// Map real-world dimensions to on-screen spine size (width = thickness, height = height)
function spineMetrics(book) {
  const d = book.dimensions || {};
  let heightCm = parseCm(d.height);
  let thicknessCm = parseCm(d.thickness);

  // Fall back to page count for thickness, then to typical paperback values
  if (!thicknessCm) {
    const pages = book.pageCount || 0;
    thicknessCm = pages ? Math.min(6, Math.max(0.8, pages * 0.0065)) : 2.4;
  }
  if (!heightCm) heightCm = 23;

  const H = Math.round(Math.min(210, Math.max(120, heightCm * 7.2)));
  const W = Math.round(Math.min(46, Math.max(11, thicknessCm * 6.6)));
  return { width: W, height: H };
}

let previewEl = null;

// ---------- Cover colour extraction ----------
const coverColorCache = new Map();

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s, l: Math.round(l * 100) };
}

// Average the cover's pixels, favouring saturated mid-tones.
// Resolves to null when the image cannot be read (CORS / load error).
function extractCoverColor(url) {
  if (coverColorCache.has(url)) return coverColorCache.get(url);

  const promise = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);

        let r = 0, g = 0, b = 0, total = 0;
        for (let i = 0; i < data.length; i += 4) {
          const R = data[i], G = data[i + 1], B = data[i + 2];
          if (data[i + 3] < 128) continue;
          const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
          const sat = mx === 0 ? 0 : (mx - mn) / mx;
          const lum = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
          if (lum < 0.07 || lum > 0.95) continue; // skip near-black / near-white
          const weight = 0.25 + sat;
          r += R * weight; g += G * weight; b += B * weight; total += weight;
        }
        resolve(total ? rgbToHsl(r / total, g / total, b / total) : null);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });

  coverColorCache.set(url, promise);
  return promise;
}

function showSpinePreview(book, anchor) {
  hideSpinePreview();
  if (!book.thumbnail) return;
  const rect = anchor.getBoundingClientRect();
  const img = document.createElement('img');
  img.className = 'book-preview';
  img.src = book.thumbnail;
  img.alt = book.title;

  const w = 130, h = 190;
  let left = rect.right + 10;
  if (left + w > window.innerWidth - 12) left = rect.left - w - 10;
  left = Math.max(12, left);
  let top = Math.min(Math.max(12, rect.bottom - h), window.innerHeight - h - 12);

  img.style.left = `${left}px`;
  img.style.top = `${top}px`;
  document.body.appendChild(img);
  previewEl = img;
}

function hideSpinePreview() {
  if (previewEl) {
    previewEl.remove();
    previewEl = null;
  }
}

function createBookElement(book) {
  const el = document.createElement('div');
  el.className = 'book';
  el.dataset.id = book.id;

  // Size the spine from the book's real dimensions
  const { width, height } = spineMetrics(book);
  el.style.setProperty('--book-w', `${width}px`);
  el.style.setProperty('--book-height', `${height}px`);

  if (book.hue != null) {
    el.style.setProperty('--book-h', book.hue);
    el.style.setProperty('--book-l', 40 + Math.floor(Math.random() * 20));
  }

  if (book.thumbnail) {
    // Blurred strip of the actual cover, used as the spine texture
    const bg = document.createElement('div');
    bg.className = 'book-spine-bg';
    const bgImg = document.createElement('img');
    bgImg.src = book.thumbnail;
    bgImg.alt = '';
    bgImg.loading = 'lazy';
    bgImg.onerror = () => bg.remove();
    bg.appendChild(bgImg);
    el.appendChild(bg);

    // Adopt the cover's dominant hue as the spine colour (may be blocked by CORS)
    extractCoverColor(book.thumbnail).then((color) => {
      if (!color || !el.isConnected) return;
      el.style.setProperty('--book-h', color.h);
      el.style.setProperty('--book-l', Math.min(62, Math.max(28, color.l)));
    });
  }

  const title = document.createElement('div');
  title.className = 'book-title';
  title.textContent = book.title;
  el.appendChild(title);

  const del = document.createElement('button');
  del.className = 'book-delete';
  del.textContent = '×';
  del.title = 'Remove from shelf';
  del.addEventListener('click', (e) => { e.stopPropagation(); removeBook(book.id); });
  el.appendChild(del);

  el.addEventListener('click', () => openBookDetail(book));
  el.addEventListener('mouseenter', () => { if (!arrangeMode) showSpinePreview(book, el); });
  el.addEventListener('mouseleave', hideSpinePreview);

  if (arrangeMode) {
    el.draggable = true;
    el.addEventListener('dragstart', onBookDragStart);
    el.addEventListener('dragend', onBookDragEnd);
  } else {
    el.draggable = false;
  }
  return el;
}

// Drag & Drop
function setupShelfDnD(shelfEl, booksContainer) {
  booksContainer.addEventListener('dragover', (e) => {
    if (!arrangeMode || !currentDragBookId) return;
    e.preventDefault();
    const afterElement = getDragAfterElement(booksContainer, e.clientX);
    document.querySelectorAll('.book.drop-target').forEach((b) => b.classList.remove('drop-target'));
    if (afterElement) afterElement.classList.add('drop-target');
    shelfEl.classList.add('drag-over');
  });
  booksContainer.addEventListener('dragleave', (e) => {
    if (!booksContainer.contains(e.relatedTarget)) shelfEl.classList.remove('drag-over');
  });
  booksContainer.addEventListener('drop', (e) => {
    if (!arrangeMode || !currentDragBookId) return;
    e.preventDefault();
    shelfEl.classList.remove('drag-over');
    const dropShelfIndex = parseInt(booksContainer.dataset.shelf, 10);
    const afterElement = getDragAfterElement(booksContainer, e.clientX);
    moveBook(currentDragBookId, dropShelfIndex, afterElement?.dataset?.id ?? null);
    currentDragBookId = null;
  });
}

function getDragAfterElement(container, x) {
  const draggableBooks = [...container.querySelectorAll('.book:not(.dragging)')];
  return draggableBooks.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = x - box.left - box.width / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY }
  ).element;
}

function onBookDragStart(e) {
  if (!arrangeMode) { e.preventDefault(); return; }
  currentDragBookId = this.dataset.id;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onBookDragEnd() {
  this.classList.remove('dragging');
  document.querySelectorAll('.book.drop-target').forEach((b) => b.classList.remove('drop-target'));
  document.querySelectorAll('.shelf.drag-over').forEach((s) => s.classList.remove('drag-over'));
}

function moveBook(bookId, targetShelfIndex, afterBookId) {
  const book = state.books.find((b) => b.id === bookId);
  if (!book) return;
  const sourceShelf = book.shelfIndex;
  book.shelfIndex = targetShelfIndex;

  const targetBooks = state.books
    .filter((b) => b.shelfIndex === targetShelfIndex && b.id !== bookId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  let insertOrder;
  if (!afterBookId) insertOrder = targetBooks.length;
  else insertOrder = targetBooks.findIndex((b) => b.id === afterBookId) + 1;
  targetBooks.splice(insertOrder, 0, book);
  targetBooks.forEach((b, i) => (b.order = i));

  if (sourceShelf !== targetShelfIndex) {
    const sourceBooks = state.books
      .filter((b) => b.shelfIndex === sourceShelf)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    sourceBooks.forEach((b, i) => (b.order = i));
  }
  saveState();
  renderBookshelf();
}

function removeBook(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book) return;
  if (!confirm(`Remove "${book.title}" from your shelf?`)) return;
  state.books = state.books.filter((b) => b.id !== id);
  saveState();
  renderBookshelf();
  updateStats();
  toast('Book removed', 'success');
  refreshGoogleShelfButtons();
  if (els.searchInput.value.trim()) doSearch();
}

// =========================================================
// PART 4 — Book Detail Modal
// =========================================================

function openBookDetail(book) {
  els.modalBody.innerHTML = '';

  const coverBox = document.createElement('div');
  coverBox.className = book.thumbnail ? 'cover' : 'cover-placeholder';
  if (book.thumbnail) {
    const img = document.createElement('img');
    img.src = book.thumbnail;
    img.alt = book.title;
    coverBox.appendChild(img);
  } else {
    coverBox.textContent = '📖';
  }
  const info = document.createElement('div');
  info.className = 'modal-info';
  const h = document.createElement('h3');
  h.textContent = book.title;
  const author = document.createElement('div');
  author.className = 'author';
  author.textContent = book.authors.join(', ');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const metaParts = [];
  if (book.publisher) metaParts.push(book.publisher);
  if (book.publishedDate) metaParts.push(book.publishedDate);
  if (book.pageCount) metaParts.push(`${book.pageCount} pages`);
  const dims = book.dimensions || {};
  if (dims.height || dims.thickness) {
    const parts = [dims.height, dims.width, dims.thickness].filter(Boolean);
    metaParts.push(`📏 ${parts.join(' × ')}`);
  } else if (book.pageCount) {
    metaParts.push('📏 size estimated from page count');
  }
  meta.textContent = metaParts.join(' · ');
  const desc = document.createElement('div');
  desc.className = 'desc';
  desc.innerHTML = book.description
    ? book.description.slice(0, 600) + (book.description.length > 600 ? '…' : '')
    : 'No description available.';

  const pickerRow = document.createElement('div');
  pickerRow.className = 'modal-shelf-picker';
  pickerRow.innerHTML = `<label>Move to shelf:</label>`;
  const sel = document.createElement('select');
  for (let i = 0; i < state.shelfCount; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = state.shelves[i] || `Shelf ${i + 1}`;
    if (i === book.shelfIndex) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    const targetIdx = parseInt(sel.value, 10);
    if (targetIdx !== book.shelfIndex) {
      moveBook(book.id, targetIdx, null);
      toast(`Moved to ${state.shelves[targetIdx]}`, 'success');
    }
  });
  pickerRow.appendChild(sel);

  info.append(h, author, meta, desc, pickerRow);
  els.modalBody.append(coverBox, info);
  els.modal.classList.remove('hidden');
}

function closeModal() { els.modal.classList.add('hidden'); }

// =========================================================
// PART 5 — Shelf Management / Mode Switch / Stats
// =========================================================

function readLayoutInputs() {
  const rows = Math.min(6, Math.max(1, parseInt(els.shelfRows.value, 10) || 1));
  const cols = Math.min(6, Math.max(1, parseInt(els.shelfCols.value, 10) || 1));
  return { rows, cols };
}

function shelvesWord(n) {
  return n === 1 ? 'shelf' : 'shelves';
}

function updateShelfHint() {
  const { rows, cols } = readLayoutInputs();
  const total = rows * cols;
  els.shelfTotal.textContent = `= ${total} ${shelvesWord(total)}`;
}

function applyShelfLayout() {
  const { rows, cols } = readLayoutInputs();
  els.shelfRows.value = rows;
  els.shelfCols.value = cols;

  const n = rows * cols;
  const oldCount = state.shelfCount;

  state.shelfRows = rows;
  state.shelfCols = cols;
  state.shelfCount = n;

  if (n < oldCount) {
    // Merge books from removed shelves into the last remaining shelf
    state.books.forEach((b) => { if (b.shelfIndex >= n) b.shelfIndex = n - 1; });
    state.shelves.length = n;
  } else {
    while (state.shelves.length < n) state.shelves.push(`Shelf ${state.shelves.length + 1}`);
  }

  // Re-index stacking order on every shelf
  for (let i = 0; i < n; i++) {
    state.books.filter((b) => b.shelfIndex === i)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .forEach((b, idx) => (b.order = idx));
  }

  saveState();
  renderBookshelf();
  updateStats();
  updateShelfHint();
  toast(`Layout: ${rows} × ${cols} = ${n} ${shelvesWord(n)}`, 'success');
}

function setMode(mode) {
  arrangeMode = mode === 'arrange';
  els.modeArrange.classList.toggle('active', arrangeMode);
  els.modeView.classList.toggle('active', !arrangeMode);
  renderBookshelf();
}

function updateStats() {
  const total = state.books.length;
  const byShelf = new Array(state.shelfCount).fill(0);
  state.books.forEach((b) => {
    if (b.shelfIndex >= 0 && b.shelfIndex < state.shelfCount)
      byShelf[b.shelfIndex]++;
  });
  els.stats.textContent = `${total} book${total === 1 ? '' : 's'} across ${state.shelfCount} ${shelvesWord(state.shelfCount)}`;
}

// =========================================================
// PART 6 — Import / Export
// =========================================================

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `my-bookshelf-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Bookshelf exported', 'success');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.shelfCount || !Array.isArray(data.books)) throw new Error('Invalid file');
      state = data;
      normalizeLayout();
      els.shelfRows.value = state.shelfRows;
      els.shelfCols.value = state.shelfCols;
      updateShelfHint();
      saveState();
      renderBookshelf();
      updateStats();
      toast('Bookshelf imported', 'success');
    } catch { toast('Invalid import file', 'error'); }
  };
  reader.readAsText(file);
}

// =========================================================
// PART 7 — Settings Modal
// =========================================================

function openSettings() {
  els.apiKeyInput.value = googleApiKey;
  els.oauthClientId.value = oauthClientId;
  updateSettingsStatus();
  els.settingsModal.classList.remove('hidden');
}
function closeSettings() { els.settingsModal.classList.add('hidden'); }

function updateSettingsStatus() {
  els.apiKeyStatus.textContent = googleApiKey ? '✓ Set' : '⚠ Not set';
  els.apiKeyStatus.style.color = googleApiKey ? 'var(--success)' : 'var(--danger)';
  els.oauthClientStatus.textContent = oauthClientId ? '✓ Set' : '⚠ Not set';
  els.oauthClientStatus.style.color = oauthClientId ? 'var(--success)' : 'var(--danger)';
}

function saveApiKey() {
  const key = els.apiKeyInput.value.trim();
  googleApiKey = key;
  if (key) localStorage.setItem(API_KEY_STORAGE, key);
  else localStorage.removeItem(API_KEY_STORAGE);
  updateSettingsStatus();
  toast(key ? 'API key saved' : 'API key cleared', 'success');
}

function saveOAuthClientId() {
  const id = els.oauthClientId.value.trim();
  oauthClientId = id;
  if (id) localStorage.setItem(OAUTH_CLIENT_STORAGE, id);
  else localStorage.removeItem(OAUTH_CLIENT_STORAGE);
  updateSettingsStatus();
  toast(id ? 'Client ID saved' : 'Client ID cleared', 'success');
}

// =========================================================
// PART 8 — Events + Init
// =========================================================

function wireEvents() {
  els.searchBtn.addEventListener('click', doSearch);
  els.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  els.applyShelves.addEventListener('click', applyShelfLayout);
  els.shelfRows.addEventListener('input', updateShelfHint);
  els.shelfCols.addEventListener('input', updateShelfHint);
  els.shelfRows.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyShelfLayout(); });
  els.shelfCols.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyShelfLayout(); });

  // Book detail modal
  els.modalClose.addEventListener('click', closeModal);
  els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeModal(); });

  // Settings modal
  els.btnSettings.addEventListener('click', openSettings);
  els.settingsClose.addEventListener('click', closeSettings);
  els.settingsModal.addEventListener('click', (e) => { if (e.target === els.settingsModal) closeSettings(); });
  els.apiKeySave.addEventListener('click', saveApiKey);
  els.apiKeyClear.addEventListener('click', () => {
    els.apiKeyInput.value = '';
    saveApiKey();
  });
  els.oauthClientSave.addEventListener('click', saveOAuthClientId);
  els.oauthClientClear.addEventListener('click', () => {
    els.oauthClientId.value = '';
    saveOAuthClientId();
  });

  // OAuth sign-in
  els.oauthSignin.addEventListener('click', signInWithGoogle);

  // Mode switch
  els.modeArrange.addEventListener('click', () => setMode('arrange'));
  els.modeView.addEventListener('click', () => setMode('view'));

  // Import / export
  els.btnExport.addEventListener('click', exportData);
  els.btnImport.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importData(f);
    e.target.value = '';
  });

  // Global escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); closeSettings(); }
  });
}

// =========================================================
// PART 9 — URL Import
// =========================================================

function handleUrlImport() {
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get('import');
  if (!encoded) return;

  try {
    const json = decodeURIComponent(escape(atob(encoded)));
    const data = JSON.parse(json);
    if (!Array.isArray(data.books)) throw new Error('Invalid payload');

    // Show confirmation modal
    const modal = document.getElementById('modal');
    const body = document.getElementById('modal-body');
    body.innerHTML = '';

    const info = document.createElement('div');
    info.className = 'modal-info';
    const h = document.createElement('h3');
    h.textContent = `📚 ${data.books.length} Google Books found!`;
    const sub = document.createElement('p');
    sub.className = 'hint';
    sub.style.marginBottom = '12px';
    sub.textContent = data.source === 'bookmarklet'
      ? 'Extracted from Google Books via the bookmarklet. Click Import below to add them all to your shelf.'
      : 'Imported from an external source.';

    // Preview list (show first 5, then count)
    const preview = document.createElement('div');
    preview.style.cssText = 'max-height:200px;overflow-y:auto;background:#f4efe6;border-radius:6px;padding:10px;margin-bottom:12px;font-size:0.82rem;';
    data.books.slice(0, 20).forEach((b, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:2px 0;';
      row.textContent = `${i + 1}. ${b.title}${b.authors?.length ? ' — ' + b.authors.join(', ') : ''}`;
      preview.appendChild(row);
    });
    if (data.books.length > 20) {
      const more = document.createElement('div');
      more.style.cssText = 'color:#999;padding-top:4px;';
      more.textContent = `...and ${data.books.length - 20} more`;
      preview.appendChild(more);
    }

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;';
    const importBtn = document.createElement('button');
    importBtn.className = 'btn btn-primary';
    importBtn.textContent = `Import ${data.books.length} books`;
    importBtn.addEventListener('click', () => {
      let added = 0, skipped = 0;
      const existingIds = new Set(state.books.map((b) => b.googleId));
      data.books.forEach((b) => {
        // Check if already exists by title (best we can do without Google ID)
        if (state.books.some((x) => x.title.toLowerCase() === b.title.toLowerCase())) {
          skipped++;
          return;
        }
        // Try to resolve via API by searching — but we have enough info to add directly
        // Generate a synthetic googleId from title
        const apiBook = {
          googleId: 'extracted-' + b.title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40),
          title: b.title,
          authors: b.authors || ['Unknown'],
          thumbnail: b.thumbnail || '',
          description: b.description || '',
          publisher: '',
          publishedDate: '',
          pageCount: 0,
          infoLink: b.infoLink || '',
        };
        addBook(apiBook);
        added++;
      });
      toast(`Imported ${added} books${skipped ? ` (${skipped} already on shelf)` : ''}`, 'success');
      closeModal();
      // Clean URL
      history.replaceState({}, '', window.location.pathname);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.style.color = '#333';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      closeModal();
      history.replaceState({}, '', window.location.pathname);
    });

    actions.append(importBtn, cancelBtn);
    info.append(h, sub, preview, actions);
    body.append(info);
    modal.classList.remove('hidden');
  } catch (err) {
    console.error('URL import failed:', err);
    toast('Failed to parse import data', 'error');
  }
}

// =========================================================
// PART 8 — Events + Init
// =========================================================

async function init() {
  cacheDom();

  // Show current origin in settings so user can configure OAuth correctly
  const origin = window.location.origin;
  if (els.currentOrigin) els.currentOrigin.textContent = origin;

  els.shelfRows.value = state.shelfRows;
  els.shelfCols.value = state.shelfCols;
  updateShelfHint();
  oauthToken = loadOAuthToken();

  // Prefer bookshelf.json when server.py is serving the app
  await syncFromServer();

  wireEvents();
  renderBookshelf();
  updateStats();
  updateSettingsStatus();
  renderOAuthStatus();

  // Handle bookmarklet URL import
  handleUrlImport();

  // Fill in dimensions for books that were added before enrichment existed
  backfillDimensions();
}

document.addEventListener('DOMContentLoaded', init);
