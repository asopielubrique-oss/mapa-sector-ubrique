/**
 * Mapa del Sector · Piel de Ubrique — Worker API
 * Cloudflare Workers + KV + R2
 *
 * Bindings requeridos:
 *   MAPA_SECTOR_KV   → KV namespace (ya existente)
 *   MEDIA_BUCKET     → R2 bucket "mapa-sector-media" (nuevo)
 *
 * Variables de entorno (secrets):
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_ENDPOINT      → https://{ACCOUNT_ID}.r2.cloudflarestorage.com
 *   R2_PUBLIC_URL    → https://pub-XXXX.r2.dev  (sin barra final)
 *
 * Claves KV:
 *   user:<email>            → { email, password, role, empresaId?, marcaId?, permisos?, estado?, entidad? }
 *   empresa:<id>            → empresa
 *   empresa:<id>:images     → metadata de imágenes
 *   marca:<id>              → solicitud / marca { marca, contacto, email, pais, tel, idioma, ficha, estado, permisos }
 *   pending:<id>            → solicitud de registro de empresa
 *   acceso-taller:<email>   → { estado, tipo_acceso, razon, email, solicitadoAt }
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ ok: false, error: message, }, status);
}

// ─── Constantes de dominio ────────────────────────────────────────────────────

const CATEGORIAS_MARCA = [
  'asociado-fabricante', 'no-asociado-fabricante',
  'asociado-taller', 'no-asociado-taller',
  'asociado-proveedor', 'no-asociado-proveedor',
  'servicios',
];
const CATEGORIAS_TALLER = ['asociado-taller', 'no-asociado-taller'];

// ─── Helpers KV ───────────────────────────────────────────────────────────────

async function kvGet(env, key) {
  return env.MAPA_SECTOR_KV.get(key, { type: 'json' });
}

async function kvPut(env, key, value) {
  return env.MAPA_SECTOR_KV.put(key, JSON.stringify(value));
}

/** Lista todas las entradas de un prefijo, saltando las claves de imágenes. */
async function listByPrefix(env, prefix, { skipImages = false } = {}) {
  const out = [];
  let cursor;
  do {
    const page = await env.MAPA_SECTOR_KV.list({ prefix, cursor });
    for (const k of page.keys) {
      if (skipImages && k.name.includes(':images')) continue;
      const v = await kvGet(env, k.name);
      if (v) out.push(v);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** Envía un email transaccional mediante la API de Resend. */
async function sendEmail(env, { to, subject, html }) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return; // Si no hay clave configurada, no falla
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Mapa del Sector Piel de Ubrique <oficina@asopiel.com>',
        to: [to],
        subject,
        html,
      }),
    });
  } catch (e) {
    console.error('Error enviando email:', e);
  }
}

function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let p = '';
  for (const b of bytes) p += chars[b % chars.length];
  return p;
}

// ─── Geocodificación (Nominatim / OpenStreetMap) ──────────────────────────────

/**
 * Convierte una dirección a coordenadas usando Nominatim (gratuito, sin API key).
 * Añade "Ubrique, Cádiz, España" como contexto para mejorar precisión.
 * Devuelve { lat, lng } o null si no se encuentra.
 */
async function geocodificar(direccion) {
  if (!direccion || !direccion.trim()) return null;
  try {
    const query = encodeURIComponent(`${direccion.trim()}, Ubrique, Cádiz, España`);
    const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1&countrycodes=es`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'MapaSectorUbrique/1.0 (mapa.asopielubrique.es)',
        'Accept-Language': 'es',
      },
    });
    if (!resp.ok) return null;
    const results = await resp.json();
    if (!results || !results.length) return null;
    const { lat, lon } = results[0];
    return { lat: parseFloat(lat), lng: parseFloat(lon) };
  } catch {
    return null;
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function authenticate(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const idx = token.indexOf(':');
  if (idx < 0) return null;
  const userId = token.slice(0, idx);
  const password = token.slice(idx + 1);
  if (!userId || !password) return null;

  const userData = await kvGet(env, `user:${userId}`);
  if (!userData || userData.password !== password) return null;
  if (userData.estado === 'revocado') return null;
  return { ...userData, id: userId };
}

function requireRole(user, ...roles) {
  if (!user) return errorResponse('No autenticado', 401);
  if (!roles.includes(user.role)) return errorResponse('Sin permiso', 403);
  return null;
}

/**
 * Categoría normalizada de una empresa. Las empresas antiguas tienen
 * categoria 'fabricante' + asociado:true; las tratamos como asociado-fabricante.
 */
function categoriaEmpresa(empresa) {
  if (!empresa) return null;
  if (empresa.categoria === 'fabricante' && empresa.asociado) return 'asociado-fabricante';
  if (empresa.categoria === 'fabricante') return 'no-asociado-fabricante';
  return empresa.categoria || null;
}

async function categoriaDeUsuario(env, user) {
  if (!user.empresaId) return null;
  const empresa = await kvGet(env, `empresa:${user.empresaId}`);
  return categoriaEmpresa(empresa);
}

// ─── Visibilidad de la condición de asociado ──────────────────────────────────
// La condición de asociado a Asopiel solo la ve el admin. El resto de usuarios
// ve cada empresa únicamente por su tipo (fabricante, taller, proveedor, servicios).

const TIPOS = {
  'fabricante': 'fabricante',
  'taller-auxiliar': 'taller',
  'taller': 'taller',
  'proveedor': 'proveedor',
  'servicios': 'servicios',
};

/** Tipo público de una empresa, sin condición de asociado. */
function tipoEmpresa(e) {
  const c = String(e.categoria || '').replace(/^no-asociado-/, '').replace(/^asociado-/, '');
  return TIPOS[c] || c || null;
}

/** ¿Es asociado a Asopiel? Dato interno: solo se devuelve al admin. */
function esAsociado(e) {
  const c = String(e.categoria || '');
  if (c.startsWith('asociado-')) return true;
  if (c.startsWith('no-asociado-')) return false;
  return e.asociado === true;
}

/** Categoría completa, solo para el admin. */
function categoriaAdmin(e) {
  const t = tipoEmpresa(e);
  if (!t) return null;
  if (t === 'servicios') return 'servicios';
  return (esAsociado(e) ? 'asociado-' : 'no-asociado-') + t;
}

/** Vista de una empresa según quien la pide. Nunca incluye el campo asociado salvo para admin. */
function vistaEmpresa(e, user) {
  const { asociado, ...resto } = e;
  const out = { ...resto, razon: e.razon || e.nombre || '', categoria: tipoEmpresa(e) };
  if (user?.role === 'admin') {
    out.asociado = esAsociado(e);
    out.categoria = categoriaAdmin(e);
  }
  return out;
}

/** ¿Un permiso de marca (p. ej. 'asociado-fabricante') cubre esta empresa? */
function permisoCubre(permiso, e) {
  const m = String(permiso).match(/^(no-asociado-|asociado-)?(.+)$/);
  const tipo = TIPOS[m[2]] || m[2];
  if (tipo !== tipoEmpresa(e)) return false;
  if (tipo === 'servicios') return true;
  return esAsociado(e) === (m[1] !== 'no-asociado-');
}

/** Permisos de marca sin distinción de asociado, para mostrarlos a la propia marca. */
function permisosPublicos(permisos = []) {
  const sin = p => String(p).replace(/^(no-asociado-|asociado-)/, '');
  return [...new Set(permisos.map(p => TIPOS[sin(p)] || sin(p)))];
}

// ─── Presigned URL helper (S3-compatible API de R2) ──────────────────────────

async function hmacSha256(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, message));
}

function toHex(buf) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Genera una presigned URL para subir un objeto a R2 via PUT (S3 API).
 * Válida durante 15 minutos.
 */
async function generatePresignedPutUrl(env, key, contentType) {
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretKey = env.R2_SECRET_ACCESS_KEY;
  const endpoint = env.R2_ENDPOINT; // https://{ACCOUNT_ID}.r2.cloudflarestorage.com
  const bucket = 'mapa-sector-media';

  const now = new Date();
  const dateStr = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const dateShort = dateStr.slice(0, 8);
  const expiresSeconds = 900; // 15 min

  const url = new URL(`${endpoint}/${bucket}/${key}`);
  const host = url.host;
  const region = 'auto';
  const service = 's3';

  const credentialScope = `${dateShort}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;

  const queryParams = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': dateStr,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
  });

  const canonicalQueryString = queryParams.toString();
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const canonicalRequest = [
    'PUT',
    `/${bucket}/${key}`,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const encoder = new TextEncoder();
  const hashBytes = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest));
  const canonicalRequestHash = toHex(new Uint8Array(hashBytes));

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateStr,
    credentialScope,
    canonicalRequestHash,
  ].join('\n');

  async function hmac(key, msg) {
    const k = typeof key === 'string' ? encoder.encode(key) : key;
    return hmacSha256(k, encoder.encode(msg));
  }

  const kDate    = await hmac(`AWS4${secretKey}`, dateShort);
  const kRegion  = await hmacSha256(kDate, encoder.encode(region));
  const kService = await hmacSha256(kRegion, encoder.encode(service));
  const kSigning = await hmacSha256(kService, encoder.encode('aws4_request'));
  const signature = toHex(await hmacSha256(kSigning, encoder.encode(stringToSign)));

  queryParams.set('X-Amz-Signature', signature);

  return `${url.origin}${url.pathname}?${queryParams.toString()}`;
}

// ─── Slots de imagen ──────────────────────────────────────────────────────────

const IMAGE_SLOTS = ['logo', 'foto-1', 'foto-2', 'foto-3'];
const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
};
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB por imagen

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      console.error('Worker unhandled error:', e);
      return new Response(JSON.stringify({ ok: false, error: e.message || 'Error interno del servidor' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  },
};

async function handleRequest(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    // ── Imágenes ──────────────────────────────────────────────────────────────
    const imagesListMatch = path.match(/^\/empresas\/([^/]+)\/images$/);
    if (imagesListMatch && method === 'GET') {
      return handleGetImages(request, env, imagesListMatch[1]);
    }

    const uploadMatch = path.match(/^\/empresas\/([^/]+)\/upload$/);
    if (uploadMatch && method === 'POST') {
      return handleRequestUpload(request, env, uploadMatch[1]);
    }

    const confirmMatch = path.match(/^\/empresas\/([^/]+)\/images\/confirm$/);
    if (confirmMatch && method === 'POST') {
      return handleConfirmUpload(request, env, confirmMatch[1]);
    }

    const deleteMatch = path.match(/^\/empresas\/([^/]+)\/images\/([^/]+)$/);
    if (deleteMatch && method === 'DELETE') {
      return handleDeleteImage(request, env, deleteMatch[1], deleteMatch[2]);
    }

    // ── Auth ──────────────────────────────────────────────────────────────────
    if (path === '/login' && method === 'POST') {
      return handleLogin(request, env);
    }

    // ── Mapa (empresas con coordenadas) ───────────────────────────────────────
    if (path === '/mapa' && method === 'GET') {
      return handleGetMapa(request, env);
    }

    // ── Empresas ──────────────────────────────────────────────────────────────
    if (path === '/empresas' && method === 'GET') {
      return handleListEmpresas(request, env);
    }
    if (path === '/empresas' && method === 'POST') {
      return handleCreateEmpresa(request, env);
    }

    const empresaMatch = path.match(/^\/empresas\/([^/]+)$/);
    if (empresaMatch && method === 'GET') {
      return handleGetEmpresa(request, env, empresaMatch[1]);
    }
    if (empresaMatch && method === 'PUT') {
      return handleUpdateEmpresa(request, env, empresaMatch[1]);
    }
    if (empresaMatch && method === 'DELETE') {
      return handleDeleteEmpresa(request, env, empresaMatch[1]);
    }

    // ── Marcas ────────────────────────────────────────────────────────────────
    // Registro público (sin token): el formulario de marca lo usa directamente.
    if (path === '/marcas' && method === 'POST') {
      return handleSolicitudMarca(request, env);
    }
    if (path === '/marcas' && method === 'GET') {
      return handleListMarcas(request, env);
    }
    const marcaAccion = path.match(/^\/marcas\/([^/]+)\/(aprobar|revocar)$/);
    if (marcaAccion && method === 'POST') {
      return handleAccionMarca(request, env, marcaAccion[1], marcaAccion[2]);
    }
    const marcaPermisos = path.match(/^\/marcas\/([^/]+)\/permisos$/);
    if (marcaPermisos && method === 'POST') {
      return handleEditarPermisosMarca(request, env, marcaPermisos[1]);
    }
    if (path.startsWith('/marcas/')) {
      return handleMarcasRouter(request, env, path, method);
    }

    // ── Usuarios ──────────────────────────────────────────────────────────────
    if (path === '/usuarios' && method === 'GET') {
      return handleListUsuarios(request, env);
    }
    const usuarioRevocar = path.match(/^\/usuarios\/([^/]+)\/revocar$/);
    if (usuarioRevocar && method === 'POST') {
      return handleRevocarUsuario(request, env, decodeURIComponent(usuarioRevocar[1]));
    }
    const usuarioClave = path.match(/^\/usuarios\/([^/]+)\/cambiar-clave$/);
    if (usuarioClave && method === 'POST') {
      return handleCambiarClaveUsuario(request, env, decodeURIComponent(usuarioClave[1]));
    }

    // ── Talleres especializados ───────────────────────────────────────────────
    if (path === '/talleres' && method === 'GET') {
      return handleListTalleres(request, env);
    }
    if (path === '/talleres/acceso' && method === 'GET') {
      return handleEstadoAccesoTaller(request, env);
    }
    if (path === '/talleres/solicitar-acceso' && method === 'POST') {
      return handleSolicitarAccesoTaller(request, env);
    }
    if (path === '/talleres/solicitudes' && method === 'GET') {
      return handleListSolicitudesTaller(request, env);
    }
    const solAccion = path.match(/^\/talleres\/solicitudes\/([^/]+)\/(aprobar|denegar|revocar)$/);
    if (solAccion && method === 'POST') {
      return handleAccionSolicitudTaller(request, env, decodeURIComponent(solAccion[1]), solAccion[2]);
    }

    // ── Registro de empresa y aprobación admin ────────────────────────────────
    if (path === '/register' && method === 'POST') {
      return handleRegister(request, env);
    }
    if (path === '/admin/pending' && method === 'GET') {
      return handleAdminPending(request, env);
    }
    const approveMatch = path.match(/^\/admin\/approve\/([^/]+)$/);
    if (approveMatch && method === 'POST') {
      return handleAdminApprove(request, env, approveMatch[1]);
    }

    return errorResponse('Ruta no encontrada', 404);
}

// ─── Handlers de imágenes ─────────────────────────────────────────────────────

async function handleGetImages(request, env, empresaId) {
  const user = await authenticate(request, env);
  if (!user) return errorResponse('No autenticado', 401);

  const empresa = await kvGet(env, `empresa:${empresaId}`);
  if (!empresa) return errorResponse('Empresa no encontrada', 404);

  const imagesData = await kvGet(env, `empresa:${empresaId}:images`) || {};

  const publicUrl = env.R2_PUBLIC_URL;
  const images = {};
  for (const slot of IMAGE_SLOTS) {
    if (imagesData[slot]) {
      images[slot] = {
        url: `${publicUrl}/${imagesData[slot].key}`,
        key: imagesData[slot].key,
        updatedAt: imagesData[slot].updatedAt,
      };
    } else {
      images[slot] = null;
    }
  }

  return jsonResponse({ empresaId, images });
}

async function handleRequestUpload(request, env, empresaId) {
  const user = await authenticate(request, env);
  if (!user) return errorResponse('No autenticado', 401);

  const isAdmin = user.role === 'admin';
  const isOwner = user.role === 'empresa' && user.empresaId === empresaId;
  if (!isAdmin && !isOwner) return errorResponse('Sin permiso', 403);

  const empresa = await kvGet(env, `empresa:${empresaId}`);
  if (!empresa) return errorResponse('Empresa no encontrada', 404);

  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('Body inválido');

  const { slot, contentType, fileSize } = body;

  if (!IMAGE_SLOTS.includes(slot)) {
    return errorResponse(`Slot inválido. Usa: ${IMAGE_SLOTS.join(', ')}`);
  }
  if (!ALLOWED_TYPES[contentType]) {
    return errorResponse('Tipo de archivo no permitido. Usa JPEG, PNG o WebP.');
  }
  if (fileSize && fileSize > MAX_SIZE_BYTES) {
    return errorResponse('Archivo demasiado grande. Máximo 5 MB.');
  }

  const ext = ALLOWED_TYPES[contentType];
  const key = `empresas/${empresaId}/${slot}.${ext}`;

  let presignedUrl;
  try {
    presignedUrl = await generatePresignedPutUrl(env, key, contentType);
  } catch (e) {
    return errorResponse(`Error generando URL de subida: ${e.message}`, 500);
  }

  return jsonResponse({
    presignedUrl,
    key,
    expiresIn: 900,
    method: 'PUT',
    headers: { 'Content-Type': contentType },
  });
}

async function handleConfirmUpload(request, env, empresaId) {
  const user = await authenticate(request, env);
  if (!user) return errorResponse('No autenticado', 401);

  const isAdmin = user.role === 'admin';
  const isOwner = user.role === 'empresa' && user.empresaId === empresaId;
  if (!isAdmin && !isOwner) return errorResponse('Sin permiso', 403);

  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('Body inválido');

  const { slot, key } = body;
  if (!IMAGE_SLOTS.includes(slot)) return errorResponse('Slot inválido');
  if (!key || !key.startsWith(`empresas/${empresaId}/`)) {
    return errorResponse('Key inválida');
  }

  const obj = await env.MEDIA_BUCKET.head(key);
  if (!obj) return errorResponse('Imagen no encontrada en R2. Asegúrate de completar la subida primero.', 404);

  const imagesData = await kvGet(env, `empresa:${empresaId}:images`) || {};

  if (imagesData[slot] && imagesData[slot].key !== key) {
    await env.MEDIA_BUCKET.delete(imagesData[slot].key).catch(() => {});
  }

  imagesData[slot] = { key, updatedAt: new Date().toISOString() };
  await kvPut(env, `empresa:${empresaId}:images`, imagesData);

  return jsonResponse({
    ok: true,
    slot,
    url: `${env.R2_PUBLIC_URL}/${key}`,
  });
}

async function handleDeleteImage(request, env, empresaId, slot) {
  const user = await authenticate(request, env);
  if (!user) return errorResponse('No autenticado', 401);

  const isAdmin = user.role === 'admin';
  const isOwner = user.role === 'empresa' && user.empresaId === empresaId;
  if (!isAdmin && !isOwner) return errorResponse('Sin permiso', 403);

  if (!IMAGE_SLOTS.includes(slot)) return errorResponse('Slot inválido');

  const imagesData = await kvGet(env, `empresa:${empresaId}:images`) || {};
  if (!imagesData[slot]) return errorResponse('No hay imagen en ese slot', 404);

  await env.MEDIA_BUCKET.delete(imagesData[slot].key).catch(() => {});

  delete imagesData[slot];
  await kvPut(env, `empresa:${empresaId}:images`, imagesData);

  return jsonResponse({ ok: true, slot });
}

// ─── Login y empresas ─────────────────────────────────────────────────────────

async function handleLogin(request, env) {
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password) return errorResponse('Email y contraseña requeridos');

  const userId = String(email).toLowerCase().trim();
  const userData = await kvGet(env, `user:${userId}`);
  if (!userData || userData.password !== password) {
    return errorResponse('Credenciales incorrectas', 401);
  }
  if (userData.estado === 'revocado') {
    return errorResponse('Acceso revocado. Contacta con Asopiel.', 403);
  }

  let nombre = userData.nombre || userData.entidad || userData.email;
  let tipo = null;
  if (userData.empresaId) {
    const empresa = await kvGet(env, `empresa:${userData.empresaId}`);
    if (empresa) {
      nombre = empresa.razon || empresa.nombre || nombre;
      tipo = tipoEmpresa(empresa);
    }
  }

  return jsonResponse({
    token: `${userId}:${password}`,
    user: {
      id: userId,
      email: userData.email,
      role: userData.role,
      empresaId: userData.empresaId,
      nombre,
      tipo,
      permisos: userData.role === 'marca' ? permisosPublicos(userData.permisos || []) : [],
    },
  });
}

async function handleListEmpresas(request, env) {
  const user = await authenticate(request, env);
  if (!user) return errorResponse('No autenticado', 401);

  let empresas = await listByPrefix(env, 'empresa:', { skipImages: true });
  if (user.role === 'marca') {
    const permisos = user.permisos || [];
    empresas = empresas.filter(e => permisos.some(p => permisoCubre(p, e)));
  }

  const publicUrl = env.R2_PUBLIC_URL;
  for (const empresa of empresas) {
    const imagesData = await kvGet(env, `empresa:${empresa.id}:images`);
    if (imagesData && publicUrl) {
      empresa.images = {};
      for (const slot of IMAGE_SLOTS) {
        empresa.images[slot] = imagesData[slot]
          ? `${publicUrl}/${imagesData[slot].key}`
          : null;
      }
    }
  }

  return jsonResponse(empresas.map(e => vistaEmpresa(e, user)));
}

async function handleGetEmpresa(request, env, empresaId) {
  const user = await authenticate(request, env);
  if (!user) return errorResponse('No autenticado', 401);

  const empresa = await kvGet(env, `empresa:${empresaId}`);
  if (!empresa) return errorResponse('Empresa no encontrada', 404);
  if (user.role === 'marca' && !(user.permisos || []).some(p => permisoCubre(p, empresa))) {
    return errorResponse('Sin permiso', 403);
  }

  const imagesData = await kvGet(env, `empresa:${empresaId}:images`);
  const publicUrl = env.R2_PUBLIC_URL;
  if (imagesData && publicUrl) {
    empresa.images = {};
    for (const slot of IMAGE_SLOTS) {
      empresa.images[slot] = imagesData[slot]
        ? `${publicUrl}/${imagesData[slot].key}`
        : null;
    }
  }

  return jsonResponse(vistaEmpresa(empresa, user));
}

async function handleCreateEmpresa(request, env) {
  const user = await authenticate(request, env);
  const authError = requireRole(user, 'admin');
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  if (!body || !body.nombre) return errorResponse('Nombre requerido');

  const id = body.id || crypto.randomUUID().slice(0, 8);
  const empresa = {
    id,
    nombre: body.nombre,
    categoria: body.categoria || 'fabricante',
    asociado: body.asociado ?? true,
    direccion: body.direccion || '',
    telefono: body.telefono || '',
    email: body.email || '',
    web: body.web || '',
    descripcion: body.descripcion || '',
    especialidades: body.especialidades || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await kvPut(env, `empresa:${id}`, empresa);
  return jsonResponse(empresa, 201);
}

async function handleUpdateEmpresa(request, env, empresaId) {
  const user = await authenticate(request, env);
  const authError = requireRole(user, 'admin', 'empresa');
  if (authError) return authError;

  if (user.role === 'empresa' && user.empresaId !== empresaId) {
    return errorResponse('Sin permiso', 403);
  }

  const empresa = await kvGet(env, `empresa:${empresaId}`);
  if (!empresa) return errorResponse('Empresa no encontrada', 404);

  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('Body inválido');

  // Solo el admin puede cambiar la condición de asociado o la categoría.
  if (user.role !== 'admin') {
    delete body.asociado;
    delete body.categoria;
  }

  const updated = { ...empresa, ...body, id: empresaId, updatedAt: new Date().toISOString() };
  if ('asociado' in body) updated.categoria = tipoEmpresa(updated);

  // Geocodificar si la dirección ha cambiado y no tiene coordenadas o cambió
  const dirCambiada = body.direccion !== undefined && body.direccion !== empresa.direccion;
  if (dirCambiada && body.direccion) {
    const coords = await geocodificar(body.direccion);
    if (coords) {
      updated.lat = coords.lat;
      updated.lng = coords.lng;
    }
  }

  await kvPut(env, `empresa:${empresaId}`, updated);
  return jsonResponse(vistaEmpresa(updated, user));
}

async function handleDeleteEmpresa(request, env, empresaId) {
  const user = await authenticate(request, env);
  const authError = requireRole(user, 'admin');
  if (authError) return authError;

  const imagesData = await kvGet(env, `empresa:${empresaId}:images`);
  if (imagesData) {
    for (const slot of IMAGE_SLOTS) {
      if (imagesData[slot]) {
        await env.MEDIA_BUCKET.delete(imagesData[slot].key).catch(() => {});
      }
    }
    await env.MAPA_SECTOR_KV.delete(`empresa:${empresaId}:images`);
  }

  await env.MAPA_SECTOR_KV.delete(`empresa:${empresaId}`);
  return jsonResponse({ ok: true });
}

// ─── Mapa del Sector ──────────────────────────────────────────────────────────

/**
 * GET /mapa — Devuelve las empresas con coordenadas lat/lng.
 * Admin ve todas. Marca ve solo las de sus categorías de permiso.
 * Datos devueltos: id, razon, categoria, lat, lng, actividades, dir.
 */
async function handleGetMapa(request, env) {
  const user = await authenticate(request, env);
  if (!user) return errorResponse('No autenticado', 401);
  if (!['admin', 'marca'].includes(user.role)) return errorResponse('Sin permiso', 403);

  let empresas = await listByPrefix(env, 'empresa:', { skipImages: true });

  // Filtrar por permisos si es marca
  if (user.role === 'marca') {
    const permisos = user.permisos || [];
    empresas = empresas.filter(e => permisos.some(p => permisoCubre(p, e)));
  }

  // Devolver solo las que tienen coordenadas, con campos mínimos
  const data = empresas
    .filter(e => e.lat != null && e.lng != null)
    .map(e => ({
      id: e.id,
      razon: e.razon || e.nombre || '',
      categoria: user.role === 'admin' ? categoriaAdmin(e) : tipoEmpresa(e),
      lat: e.lat,
      lng: e.lng,
      actividades: e.especialidades || e.actividades || [],
      dir: e.direccion || '',
    }));

  return jsonResponse(data);
}

// ─── Marcas ───────────────────────────────────────────────────────────────────

/** POST /marcas — registro público desde el formulario de marca (sin token). */
async function handleSolicitudMarca(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('Body inválido');

  const marca = String(body.marca || '').trim();
  const contacto = String(body.contacto || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const pais = String(body.pais || '').trim();
  if (!marca || !contacto || !email || !pais) {
    return errorResponse('Faltan campos obligatorios');
  }

  const id = crypto.randomUUID().slice(0, 8);
  const registro = {
    id,
    marca,
    contacto,
    email,
    pais,
    tel: body.tel || '',
    idioma: body.idioma || 'es',
    ficha: body.ficha || null,
    estado: 'pendiente',
    permisos: [],
    createdAt: new Date().toISOString(),
    // Evidencia de consentimiento RGPD (art. 7 RGPD)
    gdpr_consent: true,
    gdpr_consent_ts: new Date().toISOString(),
    gdpr_consent_ip: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown',
    gdpr_text_version: '1.0',
  };
  await kvPut(env, `marca:${id}`, registro);
  return jsonResponse({ ok: true, id }, 201);
}

/** GET /marcas — solo admin. Devuelve array (el frontend acepta array o { data }). */
async function handleListMarcas(request, env) {
  const user = await authenticate(request, env);
  const authError = requireRole(user, 'admin');
  if (authError) return authError;

  const marcas = await listByPrefix(env, 'marca:');
  marcas.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return jsonResponse({ ok: true, data: marcas });
}

/** POST /marcas/:id/aprobar  { permisos: [...] } → crea usuario rol marca y devuelve la contraseña una vez.
 *  POST /marcas/:id/revocar  { motivo }          → revoca marca y usuario asociado. */
async function handleAccionMarca(request, env, marcaId, accion) {
  const user = await authenticate(request, env);
  const authError = requireRole(user, 'admin');
  if (authError) return authError;

  const marca = await kvGet(env, `marca:${marcaId}`);
  if (!marca) return errorResponse('Marca no encontrada', 404);
  const body = await request.json().catch(() => ({}));
  const emailMarca = marca.email;

  if (accion === 'aprobar') {
    const permisos = Array.isArray(body.permisos)
      ? body.permisos.filter(p => CATEGORIAS_MARCA.includes(p))
      : [];
    if (!permisos.length) return errorResponse('Asigna al menos una categoría de permiso');

    const password = generatePassword();
    await kvPut(env, `user:${emailMarca}`, {
      email: emailMarca,
      password,
      role: 'marca',
      marcaId,
      nombre: marca.contacto,
      entidad: marca.marca,
      permisos,
      estado: 'activo',
      createdAt: new Date().toISOString(),
    });

    marca.estado = 'aprobada';
    marca.permisos = permisos;
    marca.aprobadaAt = new Date().toISOString();
    await kvPut(env, `marca:${marcaId}`, marca);

    // Enviar credenciales por email
    await sendEmail(env, {
      to: emailMarca,
      subject: 'Acceso concedido al Mapa del Sector Piel de Ubrique',
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
          <h2 style="color:#1a472a">✅ Su marca ha sido aprobada</h2>
          <p>Estimado/a <strong>${marca.contacto || marca.marca}</strong>,</p>
          <p>Su solicitud de acceso al <strong>Mapa del Sector Piel de Ubrique</strong> ha sido aprobada. A continuación sus credenciales de acceso:</p>
          <div style="background:#f4f4f4;border-radius:8px;padding:16px;margin:16px 0">
            <p style="margin:4px 0"><strong>URL:</strong> <a href="https://clusterubrique.asopiel.com">clusterubrique.asopiel.com</a></p>
            <p style="margin:4px 0"><strong>Usuario:</strong> ${emailMarca}</p>
            <p style="margin:4px 0"><strong>Contraseña:</strong> <code style="background:#e0e0e0;padding:2px 6px;border-radius:4px">${password}</code></p>
          </div>
          <p>Le recomendamos cambiar su contraseña tras el primer acceso.</p>
          <p style="color:#666;font-size:13px">Asopiel · Asociación de Empresarios del Sector de la Piel de Ubrique<br>gerencia@asopiel.com</p>
        </div>
      `,
    });

    return jsonResponse({ ok: true, email: emailMarca, password });
  }

  // revocar
  marca.estado = 'revocada';
  marca.motivoRevocacion = body.motivo || '';
  marca.revocadaAt = new Date().toISOString();
  await kvPut(env, `marca:${marcaId}`, marca);

  const u = await kvGet(env, `user:${emailMarca}`);
  if (u) {
    u.estado = 'revocado';
    await kvPut(env, `user:${emailMarca}`, u);
  }
  return jsonResponse({ ok: true });
}

/** POST /marcas/:id/permisos  { permisos: [...] } → actualiza epígrafes sin revocar acceso. */
async function handleEditarPermisosMarca(request, env, marcaId) {
  const user = await authenticate(request, env);
  const authError = requireRole(user, 'admin');
  if (authError) return authError;

  const marca = await kvGet(env, `marca:${marcaId}`);
  if (!marca) return errorResponse('Marca no encontrada', 404);
  if (marca.estado !== 'aprobada') return errorResponse('La marca no está aprobada', 400);

  const body = await request.json().catch(() => ({}));
  const permisos = Array.isArray(body.permisos)
    ? body.permisos.filter(p => CATEGORIAS_MARCA.includes(p))
    : [];
  if (!permisos.length) return errorResponse('Asigna al menos una categoría de permiso');

  // Actualizar la marca
  marca.permisos = permisos;
  marca.permisosEditadosAt = new Date().toISOString();
  await kvPut(env, `marca:${marcaId}`, marca);

  // Actualizar también el usuario asociado
  const emailMarca = marca.email;
  const u = await kvGet(env, `user:${emailMarca}`);
  if (u) {
    u.permisos = permisos;
    await kvPut(env, `user:${emailMarca}`, u);
  }

  return jsonResponse({ ok: true, permisos });
}

/** PUT y DELETE sobre /marcas/:id (solo admin). */
async function handleMarcasRouter(request, env, path, method) {
  const user = await authenticate(request, env);
  const authError = requireRole(user, 'admin');
  if (authError) return authError;

  const m = path.match(/^\/marcas\/([^/]+)$/);
  if (!m) return errorResponse('Ruta no encontrada', 404);
  const marcaId = m[1];

  if (method === 'PUT') {
    const existing = await kvGet(env, `marca:${marcaId}`);
    if (!existing) return errorResponse('Marca no encontrada', 404);
    const body = await request.json().catch(() => null);
    if (!body) return errorResponse('Body inválido');
    const updated = { ...existing, ...body, id: marcaId, updatedAt: new Date().toISOString() };
    await kvPut(env, `marca:${marcaId}`, updated);
    return jsonResponse(updated);
  }

  if (method === 'DELETE') {
    await env.MAPA_SECTOR_KV.delete(`marca:${marcaId}`);
    return jsonResponse({ ok: true });
  }

  return errorResponse('Método no permitido', 405);
}

// ─── Usuarios (admin) ─────────────────────────────────────────────────────────

/** GET /usuarios — lista sin contraseñas. El campo id es el email (clave KV). */
async function handleListUsuarios(request, env) {
  const user = await authenticate(request, env);
  const authError = requireRole(user, 'admin');
  if (authError) return authError;

  const raw = await listByPrefix(env, 'user:');
  const data = [];
  for (const u of raw) {
    let entidad = u.entidad || '';
    if (!entidad && u.empresaId) {
      const emp = await kvGet(env, `empresa:${u.empresaId}`);
      entidad = emp?.nombre || '';
    }
    data.push({
      id: u.email,
      email: u.email,
      rol: u.role,
      entidad,
      permisos: u.permisos || [],
      estado: u.estado || 'activo',
    });
  }
  return jsonResponse({ ok: true, data });
}

/** POST /usuarios/:email/revocar  { motivo } (solo admin; no revoca admins). */
async function handleRevocarUsuario(request, env, email) {
  const user = await authenticate(request, env);
  const authError = requireRole(user, 'admin');
  if (authError) return authError;

  const u = await kvGet(env, `user:${email}`);
  if (!u) return errorResponse('Usuario no encontrado', 404);
  if (u.role === 'admin') return errorResponse('No se puede revocar un administrador', 403);

  const body = await request.json().catch(() => ({}));
  u.estado = 'revocado';
  u.motivoRevocacion = body.motivo || '';
  u.revocadoAt = new Date().toISOString();
  await kvPut(env, `user:${email}`, u);
  return jsonResponse({ ok: true });
}

/** POST /usuarios/:email/cambiar-clave  → genera nueva contraseña y la devuelve. */
async function handleCambiarClaveUsuario(request, env, email) {
  const user = await authenticate(request, env);
  const authError = requireRole(user, 'admin');
  if (authError) return authError;

  const u = await kvGet(env, `user:${email}`);
  if (!u) return errorResponse('Usuario no encontrado', 404);
  if (u.role === 'admin') return errorResponse('No se puede cambiar la clave de un administrador', 403);

  const password = generatePassword();
  u.password = password;
  u.claveActualizadaAt = new Date().toISOString();
  await kvPut(env, `user:${email}`, u);

  // Enviar nueva contraseña por email
  await sendEmail(env, {
    to: email,
    subject: 'Nueva contraseña — Mapa del Sector Piel de Ubrique',
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <h2 style="color:#1a472a">🔑 Nueva contraseña de acceso</h2>
        <p>Estimado/a <strong>${u.nombre || u.entidad || email}</strong>,</p>
        <p>El administrador ha generado una nueva contraseña para su acceso al <strong>Mapa del Sector Piel de Ubrique</strong>:</p>
        <div style="background:#f4f4f4;border-radius:8px;padding:16px;margin:16px 0">
          <p style="margin:4px 0"><strong>URL:</strong> <a href="https://clusterubrique.asopiel.com">clusterubrique.asopiel.com</a></p>
          <p style="margin:4px 0"><strong>Usuario:</strong> ${email}</p>
          <p style="margin:4px 0"><strong>Contraseña:</strong> <code style="background:#e0e0e0;padding:2px 6px;border-radius:4px">${password}</code></p>
        </div>
        <p>Le recomendamos cambiar su contraseña tras iniciar sesión.</p>
        <p style="color:#666;font-size:13px">Asopiel · Asociación de Empresarios del Sector de la Piel de Ubrique<br>gerencia@asopiel.com</p>
      </div>
    `,
  });

  return jsonResponse({ ok: true, email, password });
}

// ─── Talleres especializados ──────────────────────────────────────────────────

/** GET /talleres — fabricantes con acceso aprobado/auto, o admin. */
async function handleListTalleres(request, env) {
  const user = await authenticate(request, env);
  if (!user) return errorResponse('No autenticado', 401);

  if (user.role !== 'admin') {
    const estado = await estadoAccesoTaller(env, user);
    if (estado !== 'aprobado') {
      return errorResponse('Sin acceso al directorio de talleres', 403);
    }
  }

  const empresas = await listByPrefix(env, 'empresa:', { skipImages: true });
  const data = empresas
    .filter(e => tipoEmpresa(e) === 'taller')
    .map(e => ({
      id: e.id,
      razon: e.razon || e.nombre || '',
      categoria: 'taller',
      actividades: e.especialidades || [],
      responsable: e.responsable || e.representante || '',
      tel: e.telefono || '',
      email: e.email || '',
      capacidad: e.capacidad || '',
    }));

  return jsonResponse({ ok: true, data });
}

/** Mismo flujo para todos los fabricantes: solicitud y aprobación del admin. */
async function estadoAccesoTaller(env, user) {
  const rec = await kvGet(env, `acceso-taller:${user.email}`);
  return rec?.estado || 'sin-solicitud';
}

/** GET /talleres/acceso */
async function handleEstadoAccesoTaller(request, env) {
  const user = await authenticate(request, env);
  if (!user) return errorResponse('No autenticado', 401);
  if (user.role === 'admin') return jsonResponse({ ok: true, estado: 'auto' });
  const estado = await estadoAccesoTaller(env, user);
  return jsonResponse({ ok: true, estado });
}

/** POST /talleres/solicitar-acceso — automático para asociados, pendiente para el resto. */
async function handleSolicitarAccesoTaller(request, env) {
  const user = await authenticate(request, env);
  if (!user) return errorResponse('No autenticado', 401);

  const actual = await kvGet(env, `acceso-taller:${user.email}`);
  if (actual?.estado === 'aprobado') return jsonResponse({ ok: true, estado: 'aprobado' });

  const empresa = user.empresaId ? await kvGet(env, `empresa:${user.empresaId}`) : null;
  await kvPut(env, `acceso-taller:${user.email}`, {
    email: user.email,
    razon: empresa?.razon || empresa?.nombre || user.nombre || user.email,
    tipo_acceso: 'manual',
    estado: 'pendiente',
    solicitadoAt: new Date().toISOString(),
  });

  return jsonResponse({ ok: true, estado: 'pendiente' });
}

/** GET /talleres/solicitudes — solo admin. */
async function handleListSolicitudesTaller(request, env) {
  const user = await authenticate(request, env);
  const authError = requireRole(user, 'admin');
  if (authError) return authError;

  const data = await listByPrefix(env, 'acceso-taller:');
  return jsonResponse({
    ok: true,
    data: data.map(s => ({ id: s.email, ...s })),
  });
}

/** POST /talleres/solicitudes/:email/(aprobar|denegar|revocar) — solo admin. */
async function handleAccionSolicitudTaller(request, env, email, accion) {
  const user = await authenticate(request, env);
  const authError = requireRole(user, 'admin');
  if (authError) return authError;

  const rec = await kvGet(env, `acceso-taller:${email}`);
  if (!rec) return errorResponse('Solicitud no encontrada', 404);

  rec.estado = accion === 'aprobar' ? 'aprobado' : accion === 'denegar' ? 'denegado' : 'revocado';
  rec.resueltoAt = new Date().toISOString();
  await kvPut(env, `acceso-taller:${email}`, rec);
  return jsonResponse({ ok: true, estado: rec.estado });
}

// ─── Registro de empresa y aprobación admin (existentes) ─────────────────────

async function handleRegister(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('Body inválido');

  const { tipo, ...data } = body;
  const id = crypto.randomUUID().slice(0, 8);
  const pending = {
    id, tipo, ...data,
    status: 'pending',
    createdAt: new Date().toISOString(),
    // Evidencia de consentimiento RGPD (art. 7 RGPD)
    gdpr_consent: true,
    gdpr_consent_ts: new Date().toISOString(),
    gdpr_consent_ip: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown',
    gdpr_text_version: '1.0',
  };
  await kvPut(env, `pending:${id}`, pending);
  return jsonResponse({ ok: true, id }, 201);
}

async function handleAdminPending(request, env) {
  const user = await authenticate(request, env);
  const authError = requireRole(user, 'admin');
  if (authError) return authError;

  const pending = await listByPrefix(env, 'pending:');
  return jsonResponse(pending);
}

// ─── Telegram ────────────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = '8981585313:AAE0lx_u6vZS6iYU2ernmUVu_OSSygYakqM';
const TELEGRAM_CHANNEL_ID = '-1003844028472';
const TELEGRAM_INVITE_LINK = 'https://t.me/+mJ2jSrZ9-wQyMzQ8';

/** Envía un mensaje de texto al canal de Asopiel vía bot */
async function sendTelegramMessage(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHANNEL_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
  } catch (e) {
    // No bloquear el flujo si Telegram falla
    console.error('Telegram error:', e);
  }
}

/** Envía el enlace de invitación al email de la empresa recién aprobada */
async function notificarEmpresaAprobada(razon, email) {
  const texto = `✅ <b>${razon}</b> ha sido aprobada en el Mapa del Sector Piel de Ubrique.\n\nUnirse al canal de Asopiel: ${TELEGRAM_INVITE_LINK}`;
  await sendTelegramMessage(texto);
}

async function handleAdminApprove(request, env, pendingId) {
  const user = await authenticate(request, env);
  const authError = requireRole(user, 'admin');
  if (authError) return authError;

  const pending = await kvGet(env, `pending:${pendingId}`);
  if (!pending) return errorResponse('Solicitud no encontrada', 404);

  const body = await request.json().catch(() => ({}));
  const password = body.password || generatePassword();
  const email = pending.email || `${pendingId}@mapa.asopiel.es`;

  if (pending.tipo === 'empresa') {
    // Intentar geocodificar la dirección al aprobar
    let lat = null, lng = null;
    if (pending.direccion) {
      const coords = await geocodificar(pending.direccion);
      if (coords) { lat = coords.lat; lng = coords.lng; }
    }

    const empresa = {
      id: pendingId,
      razon: pending.razon || pending.nombre || '',
      nombre: pending.nombre || pending.razon || '',
      categoria: pending.categoria || 'fabricante',
      asociado: pending.asociado ?? false,
      email,
      telefono: pending.telefono || '',
      direccion: pending.direccion || '',
      descripcion: pending.descripcion || '',
      especialidades: pending.especialidades || [],
      responsable: pending.responsable || '',
      trab_prod: pending.trab_prod || '',
      trab_total: pending.trab_total || '',
      capacidad: pending.capacidad || '',
      ...(lat != null ? { lat, lng } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await kvPut(env, `empresa:${pendingId}`, empresa);
    await kvPut(env, `user:${email}`, {
      email, password, role: 'empresa', empresaId: pendingId, estado: 'activo',
    });
  } else {
    await kvPut(env, `user:${email}`, {
      email, password, role: pending.tipo || 'consulta', estado: 'activo',
    });
  }

  await env.MAPA_SECTOR_KV.delete(`pending:${pendingId}`);

  // Notificar por Telegram si es una empresa
  if (pending.tipo === 'empresa') {
    const razon = pending.razon || pending.nombre || email;
    await notificarEmpresaAprobada(razon, email);
  }

  return jsonResponse({ ok: true, email, password });
}
