// App del jurado: formulario de actas + cola offline-first.
// Regla contable (candidatos+BLANCO+NULO+NO_MARCADO = sufragantes): si no cuadra,
// el servidor responde `dudosa` (va a verificación humana); aquí solo se avisa.
import { crearColaOffline } from './offlineQueue.js';
import { crearStorageIDB } from './idb.js';
import { crearClienteJurado, urlPorDefecto } from './ws.js';

const $ = (id) => document.getElementById(id);
const CANDIDATOS = ['C1', 'C2', 'C3', 'C4'];

const refs = {
  badge: $('badge-conexion'),
  avisoIDB: $('aviso-idb'),
  suma: $('suma'),
  historial: $('historial'),
  toasts: $('toasts'),
};

const storage = crearStorageIDB();
if (!storage.persistente) {
  refs.avisoIDB.hidden = false;
}
const cola = crearColaOffline({ storage });
const cliente = crearClienteJurado({
  onEstado: pintarEstado,
  onRespuestaInesperada: (msg) => toast(`Respuesta inesperada: ${JSON.stringify(msg)}`, 'warn'),
});

let jurado = null;
let wsUrl = null;

function pintarEstado(e) {
  refs.badge.className = 'badge ' + (e === 'conectada' ? 'on' : e === 'desconectada' ? 'off' : 'mid');
  refs.badge.textContent = e === 'conectada' ? 'conectado' : e === 'desconectada' ? 'sin conexión' : 'conectando…';
  if (e === 'conectada') bombear();
}

function toast(texto, tipo = '') {
  const el = document.createElement('div');
  el.className = `toast ${tipo}`.trim();
  el.textContent = texto;
  refs.toasts.append(el);
  setTimeout(() => el.remove(), 6000);
}

/** Intenta drenar la cola si hay transporte. Nunca borra pendientes. */
function bombear() {
  cola.procesar({
    puedeEnviar: () => cliente.conectado() && navigator.onLine !== false,
    enviar: (envio) => cliente.enviarActa(envio.acta),
  }).catch(() => {});
}

async function pintarHistorial() {
  const envios = await cola.listar();
  if (envios.length === 0) {
    refs.historial.innerHTML = '<li class="muted">Sin transmisiones todavía.</li>';
    return;
  }
  refs.historial.innerHTML = envios
    .slice()
    .reverse()
    .map((e) => {
      const r = e.respuesta ? ` · servidor: <strong>${esc(e.respuesta.estado)}</strong>` : '';
      const err = e.ultimoError ? ` · ${esc(e.ultimoError)}` : '';
      const detalle = e.respuesta ? `<br><span class="muted">recibo <code>${esc(e.respuesta.recibo ?? '—')}</code></span>` : '';
      const btn = e.estado === 'FAILED' ? ` <button type="button" data-reintentar="${esc(e.id)}">Reintentar</button>` : '';
      return `<li><span class="pill ${e.estado.toLowerCase()}">${e.estado}</span>
        <code>${esc(e.acta.acta)}</code> v${e.acta.version} · intentos ${e.intentos}${r}${err}${detalle}${btn}</li>`;
    })
    .join('');
}
cola.suscribir(pintarHistorial);

refs.historial.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-reintentar]');
  if (!btn) return;
  await cola.reintentar(btn.dataset.reintentar);
  bombear();
});

function leerEntero(id) {
  const v = $(id).value.trim();
  if (!/^\d+$/.test(v)) return null;
  return Number(v);
}

function leerFormulario() {
  const votos = {};
  for (const c of CANDIDATOS) {
    const v = leerEntero(`v-${c}`);
    if (v === null) return { error: `Votos de ${c} inválidos (entero ≥ 0).` };
    votos[c] = v;
  }
  for (const k of ['BLANCO', 'NULO', 'NO_MARCADO']) {
    const v = leerEntero(`v-${k}`);
    if (v === null) return { error: `Votos de ${k} inválidos (entero ≥ 0).` };
    votos[k] = v;
  }
  const sufragantes = leerEntero('sufragantes');
  if (sufragantes === null) return { error: 'Sufragantes inválido.' };
  const mesa = leerEntero('mesa');
  const puesto = leerEntero('puesto');
  const municipio = leerEntero('municipio');
  const corp = leerEntero('corp');
  const version = leerEntero('version');
  if ([mesa, puesto, municipio, corp, version].some((x) => x === null || x <= 0)) {
    return { error: 'Mesa, puesto, municipio, corporación y versión deben ser enteros ≥ 1.' };
  }
  const acta = {
    acta: `E14-${puesto}-${mesa}-${corp}`,
    mesa,
    puesto,
    municipio,
    version,
    jurado,
    ts_cierre: Math.floor(Date.now() / 1000),
    votos,
    sufragantes,
    hash_foto: $('hash').value.trim() || 'sin-foto',
    idem: crypto.randomUUID(),
  };
  return { acta };
}

function actualizarSuma() {
  let suma = 0;
  let ok = true;
  for (const c of [...CANDIDATOS, 'BLANCO', 'NULO', 'NO_MARCADO']) {
    const v = leerEntero(`v-${c}`);
    if (v === null) {
      ok = false;
      break;
    }
    suma += v;
  }
  const suf = leerEntero('sufragantes');
  refs.suma.textContent =
    !ok || suf === null ? '—' : suma === suf ? `✓ ${suma} = ${suf}` : `⚠ ${suma} ≠ ${suf} (quedará dudosa)`;
}

document.querySelectorAll('#form-acta input').forEach((i) => i.addEventListener('input', actualizarSuma));

$('form-acta').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const { acta, error } = leerFormulario();
  if (error) {
    toast(error, 'bad');
    return;
  }
  // Guardar ANTES de transmitir (offline-first): si se cae la red o se cierra,
  // el acta ya está persistida y se reintenta al volver.
  const envio = await cola.guardar(acta);
  toast(`Acta ${acta.acta} guardada (${envio.idem.slice(0, 8)}…). Se enviará al haber conexión.`);
  ev.target.reset();
  $('version').value = '1';
  actualizarSuma();
  bombear();
});

window.addEventListener('online', () => {
  toast('Conexión recuperada. Reintentando envíos…');
  bombear();
});
window.addEventListener('offline', () => toast('Sin conexión. Los envíos quedan en cola.', 'warn'));

// Login.
const params = new URLSearchParams(location.search);
if (params.get('jurado')) $('login-jurado').value = params.get('jurado');

$('login-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  jurado = $('login-jurado').value.trim();
  if (!jurado) {
    toast('Indica tu ID de jurado.', 'bad');
    return;
  }
  wsUrl = $('login-ws').value.trim() || urlPorDefecto(jurado);
  $('chip-jurado').textContent = jurado;
  $('login').hidden = true;
  $('app').hidden = false;
  cliente.conectar(wsUrl);
  pintarHistorial();
  bombear();
});

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}
