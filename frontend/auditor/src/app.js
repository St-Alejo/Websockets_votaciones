// Consola de auditores: cola en vivo + presencia + toma colaborativa.
// La asignación la confirma el servidor (bloqueo Redis); aquí solo se pide.
import { crearStore } from './store.js';
import { crearClienteWS, urlPorDefecto } from './ws.js';
import {
  MENSAJES_ERROR,
  escapeHtml,
  pintar,
  pintarCola,
  pintarPresencia,
  toast,
} from './ui.js';

const $ = (id) => document.getElementById(id);
const store = crearStore();
const refs = {
  badge: $('badge-conexion'),
  stPend: $('st-pend'),
  stAsig: $('st-asig'),
  stRes: $('st-res'),
  stOn: $('st-on'),
  stOff: $('st-off'),
  miCaso: $('mi-caso'),
  log: $('log'),
  tbodyCola: $('tbody-cola'),
  tbodyPresencia: $('tbody-presencia'),
  toasts: $('toasts'),
};

const filtros = { texto: '', estado: 'todas', prioMin: '' };
function repintar() {
  pintar(store.estado, refs);
  pintarCola(store.estado, refs, filtros);
  pintarPresencia(store.estado, refs);
}
store.suscribir(repintar);
// Refresca los "hace Xs" cada 10 s.
setInterval(() => pintarPresencia(store.estado, refs), 10_000);

const cliente = crearClienteWS({
  obtenerActaActual: () => store.estado.miCaso?.acta ?? null,
  onEstado: (e) => {
    store.actualizar({ conectada: e === 'conectada' ? true : e === 'desconectada' ? 'x' : 'c' });
  },
  onAbierto: () => {
    cliente.enviar({ tipo: 'latido', acta: store.estado.miCaso?.acta ?? null });
    store.agregarLog('Conexión establecida con el servidor.');
  },
  onMensaje: (msg) => alRecibir(msg),
});

function alRecibir(msg) {
  const e = store.estado;
  switch (msg.tipo) {
    case 'hola':
      store.actualizar({ instancia: msg.instancia, cola: msg.cola ?? [], presentes: msg.presentes ?? [] });
      store.marcarVistos(msg.presentes ?? []);
      $('subtitulo').textContent = `Instancia ${msg.instancia} · ${msg.cola?.length ?? 0} actas en cola`;
      store.agregarLog(`Hola de ${msg.instancia}: ${msg.cola?.length ?? 0} actas, ${msg.presentes?.length ?? 0} en línea.`);
      break;
    case 'latido_ok':
      break;
    case 'caso':
      if (!msg.caso) {
        toast(refs.toasts, 'Cola vacía o todo ocupado. Intenta de nuevo en unos segundos.');
      } else {
        store.actualizar({ miCaso: msg.caso });
        store.agregarLog(`Tomaste ${msg.caso.acta} (token ${msg.caso.token.slice(0, 8)}…).`, 'e-asignada');
        toast(refs.toasts, `Caso asignado: ${msg.caso.acta}`);
      }
      break;
    case 'liberado':
      if (msg.ok) {
        if (e.miCaso?.acta === msg.acta) store.actualizar({ miCaso: null });
        store.agregarLog(`Liberaste ${msg.acta}.`, 'e-liberada');
      } else {
        toast(refs.toasts, `No se pudo liberar ${msg.acta}: el bloqueo ya no es tuyo.`, 'warn');
      }
      break;
    case 'completado':
      if (msg.ok) {
        if (e.miCaso?.acta === msg.acta) store.actualizar({ miCaso: null });
        store.actualizar({ resueltasSesion: e.resueltasSesion + 1 });
        store.agregarLog(`Completaste ${msg.acta}.`, 'e-resuelta');
        toast(refs.toasts, `Acta resuelta: ${msg.acta}`);
      } else {
        toast(refs.toasts, `No se pudo completar ${msg.acta}: el bloqueo ya no es tuyo.`, 'warn');
      }
      break;
    case 'bloqueo_perdido':
      store.actualizar({ miCaso: null });
      store.agregarLog(`Perdiste el bloqueo de ${msg.acta} (otro auditor la tomó).`, 'e-liberada');
      toast(refs.toasts, `Bloqueo perdido: ${msg.acta}`, 'warn');
      break;
    case 'cola':
      store.actualizar({ cola: msg.cola ?? [] });
      if (msg.evento) {
        const ev = msg.evento;
        const quien = ev.auditor ? ` por ${escapeHtml(ev.auditor)}` : '';
        store.agregarLog(`Acta ${ev.acta}: ${ev.tipo}${quien}.`, `e-${ev.tipo}`);
      }
      break;
    case 'presentes':
      store.actualizar({ presentes: msg.presentes ?? [] });
      store.marcarVistos(msg.presentes ?? []);
      if (msg.evento) store.marcarEventoPresencia(msg.evento);
      break;
    case 'error':
      toast(refs.toasts, MENSAJES_ERROR[msg.motivo] ?? `Error: ${msg.motivo}`, 'bad');
      break;
    default:
      break;
  }
}

// Acciones de la tabla (delegación).
document.querySelector('.main').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-accion]');
  if (!btn) return;
  const accion = btn.dataset.accion;
  const miCaso = store.estado.miCaso;
  if (accion === 'tomar') {
    cliente.enviar({ tipo: 'tomar' });
  } else if ((accion === 'liberar' || accion === 'liberar-mio') && miCaso) {
    cliente.enviar({ tipo: 'liberar', acta: miCaso.acta, token: miCaso.token });
  } else if ((accion === 'completar' || accion === 'completar-mio') && miCaso) {
    if (confirm(`¿Marcar ${miCaso.acta} como verificada y sacarla de la cola?`)) {
      cliente.enviar({ tipo: 'completar', acta: miCaso.acta, token: miCaso.token });
    }
  }
});

// Filtros y refrescos.
$('f-texto').addEventListener('input', (ev) => {
  filtros.texto = ev.target.value;
  pintarCola(store.estado, refs, filtros);
});
$('f-estado').addEventListener('change', (ev) => {
  filtros.estado = ev.target.value;
  pintarCola(store.estado, refs, filtros);
});
$('f-prio').addEventListener('input', (ev) => {
  filtros.prioMin = ev.target.value;
  pintarCola(store.estado, refs, filtros);
});
$('btn-refrescar').addEventListener('click', () => cliente.enviar({ tipo: 'cola' }));
$('btn-presencia').addEventListener('click', () => cliente.enviar({ tipo: 'presentes' }));
$('btn-salir').addEventListener('click', () => {
  cliente.cerrar();
  location.reload();
});

// Login.
const params = new URLSearchParams(location.search);
if (params.get('auditor')) $('login-auditor').value = params.get('auditor');
if (params.get('ws')) $('login-ws').value = params.get('ws');

$('login-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const auditor = $('login-auditor').value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(auditor)) {
    toast(refs.toasts, 'ID inválido: usa letras, números, _ o - (máx. 64).', 'bad');
    return;
  }
  const wsUrl = $('login-ws').value.trim() || urlPorDefecto(auditor);
  store.actualizar({ auditor });
  $('chip-auditor').textContent = auditor;
  $('login').hidden = true;
  $('app').hidden = false;
  cliente.conectar(wsUrl);
});
