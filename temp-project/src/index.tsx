import { Hono } from 'hono'
import { cors } from 'hono/cors'

interface CloudflareBindings {
  SESSIONS: KVNamespace;
}

const app = new Hono<{ Bindings: CloudflareBindings }>()

app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Session-ID'],
  credentials: true,
}))

const DERIV_AUTH_URL = 'https://auth.deriv.com/oauth2/auth'
const DERIV_TOKEN_URL = 'https://auth.deriv.com/oauth2/token'

// ===== API ENDPOINTS =====

app.get('/api/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }))

app.post('/api/oauth/callback', async (c) => {
  try {
    const body = await c.req.json()
    const { code, code_verifier, redirect_uri, client_id, client_secret } = body

    if (!code || !code_verifier || !redirect_uri || !client_id || !client_secret) {
      return c.json({ error: 'Missing parameters' }, 400)
    }

    const tokenResponse = await fetch(DERIV_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri,
        client_id,
        client_secret,
        code_verifier,
      }),
    })

    const tokenData = await tokenResponse.json()

    if (!tokenResponse.ok) {
      return c.json({ error: 'Token exchange failed', details: tokenData }, 400)
    }

    const sessionId = crypto.randomUUID()
    const sessionData = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      expires_in: tokenData.expires_in,
      created_at: Date.now(),
    }

    await c.env.SESSIONS.put(
      `session:${sessionId}`,
      JSON.stringify(sessionData),
      { expirationTtl: 30 * 24 * 60 * 60 }
    )

    return c.json({
      success: true,
      session_id: sessionId,
      expires_in: tokenData.expires_in,
    })

  } catch (err: any) {
    return c.json({ error: 'Internal error', details: err.message }, 500)
  }
})

app.get('/api/session/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const sessionRaw = await c.env.SESSIONS.get(`session:${sessionId}`)
  if (!sessionRaw) return c.json({ error: 'Session not found' }, 401)
  const session = JSON.parse(sessionRaw)
  return c.json({
    valid: true,
    created_at: session.created_at,
    expires_at: session.created_at + (session.expires_in * 1000),
  })
})

app.post('/api/session/:sessionId/logout', async (c) => {
  const sessionId = c.req.param('sessionId')
  await c.env.SESSIONS.delete(`session:${sessionId}`)
  return c.json({ success: true })
})

app.post('/api/deriv/balance', async (c) => {
  const sessionId = c.req.header('X-Session-ID')
  if (!sessionId) return c.json({ error: 'Missing X-Session-ID' }, 401)

  const sessionRaw = await c.env.SESSIONS.get(`session:${sessionId}`)
  if (!sessionRaw) return c.json({ error: 'Invalid session' }, 401)

  const session = JSON.parse(sessionRaw)

  // Authorize via legacy WebSocket over HTTP
  const authResp = await fetch('https://ws.derivws.com/websockets/v3', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorize: session.access_token, req_id: 1 }),
  })
  const authData = await authResp.json()

  if (authData.error) {
    return c.json({ error: authData.error.message, code: authData.error.code }, 400)
  }

  // Get balance
  const balResp = await fetch('https://ws.derivws.com/websockets/v3', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ balance: 1, req_id: 2 }),
  })
  const balData = await balResp.json()

  return c.json({
    account: authData.authorize?.loginid,
    currency: authData.authorize?.currency,
    balance: balData.balance?.balance,
    accounts: authData.authorize?.account_list || [],
  })
})

// ===== MAIN PAGE =====

app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Deriv Copy MVP</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
<style>
.gradient-bg { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); }
.card-glass { background: rgba(30,41,59,0.8); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); }
.accent { color: #f97316; }
.btn-primary { background: linear-gradient(135deg, #f97316, #ea580c); }
.btn-primary:hover { background: linear-gradient(135deg, #ea580c, #c2410c); }
.hidden-section { display: none !important; }
.fade-in { animation: fadeIn 0.5s ease-in; }
@keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
.pulse-dot { animation: pulse 2s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
</style>
</head>
<body class="gradient-bg text-white min-h-screen">

<header class="border-b border-white/10 bg-slate-900/80 sticky top-0 z-50">
  <div class="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-lg btn-primary flex items-center justify-center"><i class="fas fa-chart-line text-white"></i></div>
      <div><h1 class="font-bold text-lg">DerivCopy MVP</h1><p class="text-xs text-slate-400">Conexion oficial con Deriv.com</p></div>
    </div>
    <div id="header-user" class="hidden items-center gap-3">
      <span class="text-xs bg-green-500/20 text-green-400 px-2 py-1 rounded flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-green-400 pulse-dot"></span>Conectado</span>
      <button onclick="logout()" class="text-xs text-slate-400 hover:text-white"><i class="fas fa-sign-out-alt mr-1"></i>Salir</button>
    </div>
  </div>
</header>

<main class="max-w-6xl mx-auto px-4 py-8">

<!-- LANDING -->
<section id="landing-section" class="text-center py-12">
  <div class="mb-8">
    <div class="w-20 h-20 rounded-2xl btn-primary flex items-center justify-center mx-auto mb-6 shadow-lg shadow-orange-500/20">
      <i class="fas fa-link text-3xl text-white"></i>
    </div>
    <h2 class="text-4xl font-bold mb-4">Conecta tu cuenta <span class="accent">Deriv</span></h2>
    <p class="text-slate-400 text-lg max-w-2xl mx-auto mb-2">MVP de Copy Trading. Conexion oficial y segura via OAuth 2.0 con Deriv.com.</p>
    <p class="text-slate-500 text-sm max-w-xl mx-auto">Tu contrasena nunca toca nuestros servidores. La autorizacion se hace directamente en Deriv.com</p>
  </div>

  <div class="grid md:grid-cols-3 gap-6 max-w-4xl mx-auto mb-12 text-left">
    <div class="card-glass rounded-xl p-6">
      <div class="w-12 h-12 rounded-lg bg-blue-500/20 flex items-center justify-center mb-4"><i class="fas fa-shield-alt text-blue-400 text-xl"></i></div>
      <h3 class="font-bold mb-2">OAuth 2.0 Oficial</h3><p class="text-sm text-slate-400">Inicia sesion directamente en Deriv.com. Nunca pedimos tu contrasena.</p>
    </div>
    <div class="card-glass rounded-xl p-6">
      <div class="w-12 h-12 rounded-lg bg-purple-500/20 flex items-center justify-center mb-4"><i class="fas fa-eye text-purple-400 text-xl"></i></div>
      <h3 class="font-bold mb-2">Ver en tiempo real</h3><p class="text-sm text-slate-400">Visualiza balances y cuentas conectadas en el dashboard.</p>
    </div>
    <div class="card-glass rounded-xl p-6">
      <div class="w-12 h-12 rounded-lg bg-green-500/20 flex items-center justify-center mb-4"><i class="fas fa-users text-green-400 text-xl"></i></div>
      <h3 class="font-bold mb-2">Terceros confiables</h3><p class="text-sm text-slate-400">Tus seguidores conectan sus cuentas con el mismo nivel de seguridad.</p>
    </div>
  </div>

  <!-- CONFIG -->
  <div class="card-glass rounded-xl p-8 max-w-lg mx-auto text-left">
    <h3 class="font-bold text-lg mb-4 flex items-center gap-2"><i class="fas fa-cog accent"></i>Configuracion Deriv OAuth</h3>
    <p class="text-sm text-slate-400 mb-4">Registra tu app en <a href="https://developers.deriv.com" target="_blank" class="accent underline">developers.deriv.com</a> para obtener client_id y client_secret.</p>
    <div class="space-y-4">
      <div>
        <label class="block text-sm font-medium mb-1">Client ID (de Deriv)</label>
        <input type="text" id="client-id" placeholder="Ej: 12345" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-orange-500">
      </div>
      <div>
        <label class="block text-sm font-medium mb-1">Client Secret (de Deriv)</label>
        <input type="password" id="client-secret" placeholder="Tu client_secret" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-orange-500">
      </div>
      <div>
        <label class="block text-sm font-medium mb-1">Redirect URI</label>
        <input type="text" id="redirect-uri" value="" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-orange-500">
        <p class="text-xs text-slate-500 mt-1">Debe coincidir EXACTAMENTE con lo registrado en tu app de Deriv</p>
      </div>
      <div class="flex gap-2">
        <button onclick="saveConfig()" class="flex-1 btn-primary text-white font-bold py-3 rounded-lg transition"><i class="fas fa-save mr-2"></i>Guardar</button>
        <button onclick="connectDemo()" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg transition"><i class="fas fa-flask mr-2"></i>Demo</button>
      </div>
    </div>
    <div id="config-saved" class="hidden mt-4 p-3 bg-green-500/20 border border-green-500/30 rounded-lg text-sm text-green-400"><i class="fas fa-check-circle mr-1"></i> Guardado en localStorage</div>
  </div>

  <div class="mt-8">
    <button onclick="startOAuth()" id="connect-btn" class="btn-primary text-white font-bold py-4 px-8 rounded-xl text-lg shadow-lg shadow-orange-500/30 transition disabled:opacity-50 disabled:cursor-not-allowed" disabled>
      <i class="fas fa-plug mr-2"></i>Conectar con Deriv
    </button>
    <p class="text-xs text-slate-500 mt-3">Seras redirigido a auth.deriv.com para autorizar</p>
  </div>
</section>

<!-- CALLBACK -->
<section id="callback-section" class="hidden-section text-center py-16">
  <div class="w-16 h-16 rounded-full border-4 border-orange-500 border-t-transparent animate-spin mx-auto mb-6"></div>
  <h2 class="text-2xl font-bold mb-2">Conectando con Deriv...</h2>
  <p class="text-slate-400">Intercambiando codigo de autorizacion por token seguro</p>
</section>

<!-- DASHBOARD -->
<section id="dashboard-section" class="hidden-section">
  <div class="mb-8"><h2 class="text-2xl font-bold mb-1">Dashboard</h2><p class="text-slate-400 text-sm">Cuentas conectadas a traves de Deriv OAuth</p></div>

  <div class="grid md:grid-cols-2 gap-6 mb-8">
    <!-- MASTER -->
    <div class="card-glass rounded-xl p-6">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-orange-500/20 flex items-center justify-center"><i class="fas fa-crown text-orange-400"></i></div>
          <div><h3 class="font-bold">Mi Cuenta Maestra</h3><p class="text-xs text-slate-400">Tu cuenta de trader principal</p></div>
        </div>
        <span class="text-xs bg-orange-500/20 text-orange-400 px-2 py-1 rounded">Principal</span>
      </div>

      <div id="master-account-loading" class="text-center py-8">
        <div class="w-8 h-8 border-2 border-orange-500 border-t-transparent animate-spin rounded-full mx-auto mb-2"></div>
        <p class="text-sm text-slate-400">Cargando datos de Deriv...</p>
      </div>

      <div id="master-account-data" class="hidden">
        <div class="grid grid-cols-2 gap-4 mb-4">
          <div class="bg-slate-800/50 rounded-lg p-3"><p class="text-xs text-slate-400 mb-1">Balance</p><p id="master-balance" class="text-xl font-bold accent">--</p></div>
          <div class="bg-slate-800/50 rounded-lg p-3"><p class="text-xs text-slate-400 mb-1">Moneda</p><p id="master-currency" class="text-xl font-bold">--</p></div>
        </div>
        <div class="bg-slate-800/50 rounded-lg p-3 mb-3"><p class="text-xs text-slate-400 mb-1">ID de Cuenta</p><p id="master-loginid" class="text-sm font-mono">--</p></div>
        <div class="bg-slate-800/50 rounded-lg p-3">
          <p class="text-xs text-slate-400 mb-1">Todas tus cuentas</p>
          <div id="master-accounts-list" class="space-y-1 mt-1"></div>
        </div>
      </div>

      <div id="master-account-error" class="hidden text-center py-4">
        <i class="fas fa-exclamation-circle text-red-400 text-2xl mb-2"></i>
        <p class="text-sm text-red-400">Error al cargar datos de Deriv</p>
        <button onclick="loadMasterAccount()" class="mt-2 text-xs accent underline">Reintentar</button>
      </div>
    </div>

    <!-- FOLLOWER -->
    <div class="card-glass rounded-xl p-6">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center"><i class="fas fa-user text-blue-400"></i></div>
          <div><h3 class="font-bold">Cuenta de Seguidor</h3><p class="text-xs text-slate-400">Simula un tercero conectado</p></div>
        </div>
        <span class="text-xs bg-blue-500/20 text-blue-400 px-2 py-1 rounded">Seguidor</span>
      </div>

      <div id="follower-status" class="text-center py-8">
        <i class="fas fa-user-plus text-slate-600 text-3xl mb-3"></i>
        <p class="text-sm text-slate-400 mb-4">Ninguna cuenta de seguidor conectada</p>
        <button onclick="connectFollower()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg text-sm transition"><i class="fas fa-plug mr-1"></i>Conectar Seguidor</button>
      </div>

      <div id="follower-account-data" class="hidden">
        <div class="grid grid-cols-2 gap-4 mb-4">
          <div class="bg-slate-800/50 rounded-lg p-3"><p class="text-xs text-slate-400 mb-1">Balance</p><p id="follower-balance" class="text-xl font-bold text-blue-400">--</p></div>
          <div class="bg-slate-800/50 rounded-lg p-3"><p class="text-xs text-slate-400 mb-1">Moneda</p><p id="follower-currency" class="text-xl font-bold">--</p></div>
        </div>
        <div class="bg-slate-800/50 rounded-lg p-3 mb-3"><p class="text-xs text-slate-400 mb-1">ID de Cuenta</p><p id="follower-loginid" class="text-sm font-mono">--</p></div>
        <button onclick="disconnectFollower()" class="text-xs text-red-400 hover:text-red-300"><i class="fas fa-unlink mr-1"></i>Desconectar</button>
      </div>
    </div>
  </div>

  <!-- FUTURE -->
  <div class="card-glass rounded-xl p-6">
    <h3 class="font-bold mb-4 flex items-center gap-2"><i class="fas fa-rocket accent"></i>Proximos pasos</h3>
    <div class="grid md:grid-cols-3 gap-4">
      <div class="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
        <div class="flex items-center gap-2 mb-2"><i class="fas fa-copy text-slate-500"></i><span class="font-medium text-sm">Copy Trading</span></div>
        <p class="text-xs text-slate-500">Replicar operaciones automaticamente</p>
        <span class="inline-block mt-2 text-xs bg-slate-700 text-slate-400 px-2 py-1 rounded">Requiere VPS</span>
      </div>
      <div class="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
        <div class="flex items-center gap-2 mb-2"><i class="fas fa-chart-bar text-slate-500"></i><span class="font-medium text-sm">Metricas</span></div>
        <p class="text-xs text-slate-500">Rendimiento, drawdown, win rate</p>
        <span class="inline-block mt-2 text-xs bg-slate-700 text-slate-400 px-2 py-1 rounded">Proximamente</span>
      </div>
      <div class="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
        <div class="flex items-center gap-2 mb-2"><i class="fas fa-credit-card text-slate-500"></i><span class="font-medium text-sm">Suscripciones</span></div>
        <p class="text-xs text-slate-500">Cobro mensual a seguidores</p>
        <span class="inline-block mt-2 text-xs bg-slate-700 text-slate-400 px-2 py-1 rounded">Proximamente</span>
      </div>
    </div>
  </div>
</section>

<div class="mt-12 text-center text-xs text-slate-600">
  <p>MVP construido con Hono + Cloudflare Pages + Deriv OAuth 2.0</p>
  <p class="mt-1">Los tokens se almacenan de forma segura en Cloudflare KV.</p>
</div>

</main>

<script>
// PKCE helpers
function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64URLEncode(array);
}
function base64URLEncode(str) {
  const bytes = str instanceof Uint8Array ? str : new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64URLEncode(new Uint8Array(digest));
}

// Config
function getConfig() {
  return {
    clientId: localStorage.getItem('dc_client_id') || '',
    clientSecret: localStorage.getItem('dc_client_secret') || '',
    redirectUri: localStorage.getItem('dc_redirect_uri') || (window.location.origin + '/callback'),
  };
}
function saveConfig() {
  const clientId = document.getElementById('client-id').value.trim();
  const clientSecret = document.getElementById('client-secret').value.trim();
  const redirectUri = document.getElementById('redirect-uri').value.trim();
  if (!clientId || !clientSecret) { alert('Client ID y Client Secret son obligatorios'); return; }
  localStorage.setItem('dc_client_id', clientId);
  localStorage.setItem('dc_client_secret', clientSecret);
  localStorage.setItem('dc_redirect_uri', redirectUri);
  document.getElementById('config-saved').classList.remove('hidden');
  document.getElementById('connect-btn').disabled = false;
  setTimeout(() => document.getElementById('config-saved').classList.add('hidden'), 4000);
}
function connectDemo() {
  document.getElementById('client-id').value = 'TU_CLIENT_ID';
  document.getElementById('client-secret').value = 'TU_CLIENT_SECRET';
  alert('Para probar en serio, registra tu app en developers.deriv.com');
}
(function loadSavedConfig() {
  const cfg = getConfig();
  if (cfg.clientId) {
    document.getElementById('client-id').value = cfg.clientId;
    document.getElementById('client-secret').value = cfg.clientSecret;
    document.getElementById('redirect-uri').value = cfg.redirectUri;
    document.getElementById('connect-btn').disabled = false;
  }
  // auto-set redirect to current origin
  if (!document.getElementById('redirect-uri').value) {
    document.getElementById('redirect-uri').value = window.location.origin + '/callback';
  }
})();

// OAuth flow
async function startOAuth() {
  const cfg = getConfig();
  if (!cfg.clientId) { alert('Primero configura tu Client ID'); return; }
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateCodeVerifier();
  sessionStorage.setItem('dc_code_verifier', codeVerifier);
  sessionStorage.setItem('dc_state', state);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: 'trade account_manage',
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  window.location.href = 'https://auth.deriv.com/oauth2/auth?' + params.toString();
}

// Callback processing
async function processCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const state = urlParams.get('state');
  const error = urlParams.get('error');

  if (error) { alert('Error de Deriv: ' + error); showSection('landing-section'); return; }

  if (!code || !state) {
    const sessionId = localStorage.getItem('dc_session_id');
    if (sessionId) { showSection('dashboard-section'); loadMasterAccount(); updateHeaderUser(true); }
    else { showSection('landing-section'); }
    return;
  }

  const savedState = sessionStorage.getItem('dc_state');
  if (state !== savedState) { alert('Error de seguridad: state no coincide'); showSection('landing-section'); return; }

  showSection('callback-section');
  const codeVerifier = sessionStorage.getItem('dc_code_verifier');
  const cfg = getConfig();

  try {
    const response = await fetch('/api/oauth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: codeVerifier, redirect_uri: cfg.redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error al intercambiar token');

    localStorage.setItem('dc_session_id', data.session_id);
    sessionStorage.removeItem('dc_code_verifier');
    sessionStorage.removeItem('dc_state');
    window.history.replaceState({}, document.title, window.location.pathname);
    showSection('dashboard-section');
    updateHeaderUser(true);
    loadMasterAccount();
  } catch (err) {
    alert('Error conectando: ' + err.message);
    showSection('landing-section');
  }
}

// Dashboard
async function loadMasterAccount() {
  const sessionId = localStorage.getItem('dc_session_id');
  if (!sessionId) return;
  document.getElementById('master-account-loading').classList.remove('hidden');
  document.getElementById('master-account-data').classList.add('hidden');
  document.getElementById('master-account-error').classList.add('hidden');
  try {
    const response = await fetch('/api/deriv/balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
      body: JSON.stringify({}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    document.getElementById('master-balance').textContent = (data.balance || 0).toLocaleString();
    document.getElementById('master-currency').textContent = data.currency || 'USD';
    document.getElementById('master-loginid').textContent = data.account || 'N/A';

    const accountsList = document.getElementById('master-accounts-list');
    accountsList.innerHTML = '';
    if (data.accounts && data.accounts.length > 0) {
      data.accounts.forEach(acc => {
        const div = document.createElement('div');
        div.className = 'flex items-center justify-between bg-slate-800/30 rounded px-2 py-1';
        const isReal = acc.account_type === 'real';
        div.innerHTML = '<span class="text-xs font-mono">' + acc.loginid + '</span><span class="text-xs ' + (isReal ? 'text-green-400' : 'text-blue-400') + '">' + (isReal ? 'REAL' : 'DEMO') + '</span>';
        accountsList.appendChild(div);
      });
    } else {
      accountsList.innerHTML = '<p class="text-xs text-slate-500">No se encontraron cuentas adicionales</p>';
    }
    document.getElementById('master-account-loading').classList.add('hidden');
    document.getElementById('master-account-data').classList.remove('hidden');
  } catch (err) {
    document.getElementById('master-account-loading').classList.add('hidden');
    document.getElementById('master-account-error').classList.remove('hidden');
  }
}

// Follower
async function connectFollower() {
  const sessionId = localStorage.getItem('dc_session_id');
  if (!sessionId) { alert('Primero conecta tu cuenta maestra'); return; }
  // Para el MVP, simulamos con la misma sesion (en produccion seria otro OAuth)
  localStorage.setItem('dc_follower_session_id', sessionId);
  loadFollowerAccount();
}
async function loadFollowerAccount() {
  const followerSession = localStorage.getItem('dc_follower_session_id');
  if (!followerSession) return;
  try {
    const response = await fetch('/api/deriv/balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-ID': followerSession },
      body: JSON.stringify({}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    document.getElementById('follower-balance').textContent = (data.balance || 0).toLocaleString();
    document.getElementById('follower-currency').textContent = data.currency || 'USD';
    document.getElementById('follower-loginid').textContent = data.account || 'N/A';
    document.getElementById('follower-status').classList.add('hidden');
    document.getElementById('follower-account-data').classList.remove('hidden');
  } catch (err) {
    alert('Error: ' + err.message);
  }
}
function disconnectFollower() {
  localStorage.removeItem('dc_follower_session_id');
  document.getElementById('follower-status').classList.remove('hidden');
  document.getElementById('follower-account-data').classList.add('hidden');
}

// UI helpers
function showSection(id) {
  document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden-section'));
  const el = document.getElementById(id);
  el.classList.remove('hidden-section');
  el.classList.add('fade-in');
}
function updateHeaderUser(connected) {
  const el = document.getElementById('header-user');
  if (connected) { el.classList.remove('hidden'); el.classList.add('flex'); }
  else { el.classList.add('hidden'); el.classList.remove('flex'); }
}
function logout() {
  const sessionId = localStorage.getItem('dc_session_id');
  if (sessionId) fetch('/api/session/' + sessionId + '/logout', { method: 'POST' });
  localStorage.removeItem('dc_session_id');
  localStorage.removeItem('dc_follower_session_id');
  updateHeaderUser(false);
  showSection('landing-section');
}

// Init
processCallback();
(function checkSession() {
  const sessionId = localStorage.getItem('dc_session_id');
  if (sessionId) {
    fetch('/api/session/' + sessionId).then(r => {
      if (!r.ok) { localStorage.removeItem('dc_session_id'); updateHeaderUser(false); }
    }).catch(()=>{});
  }
})();
</script>
</body>
</html>`)
})

export default app
