import { beforeEach, describe, expect, it } from 'vitest';
import { evaluar, leerPendiente } from '../../src/fanout/backpressure.js';
import { crearMotor } from '../../src/fanout/engine.js';
import { revisarPresion } from '../../src/fanout/index.js';
import { reiniciarTopicos } from '../../src/fanout/topics.js';

const umbrales = { suspender: 100, desconectar: 1000 };

function acta(stream_id = '1-0') {
  return {
    stream_id,
    acta: 'E14-176-0042-03',
    mun: 11,
    pue: 176,
    version: 1,
    tipo: 'nueva',
  };
}

describe('RF-9 contrapresión', () => {
  beforeEach(() => reiniciarTopicos());

  it('clasifica delta, suspensión, snapshot y desconexión', () => {
    const conexion = { bufferedAmount: 50, necesitaSnapshot: false };
    expect(leerPendiente(conexion)).toBe(50);
    expect(evaluar(conexion, umbrales).accion).toBe('delta');

    conexion.bufferedAmount = 100;
    expect(evaluar(conexion, umbrales).accion).toBe('suspender');

    conexion.bufferedAmount = 0;
    conexion.necesitaSnapshot = true;
    expect(evaluar(conexion, umbrales).accion).toBe('snapshot');

    conexion.bufferedAmount = 1000;
    expect(evaluar(conexion, umbrales).accion).toBe('desconectar');

    const porSocket = { socket: { writableLength: 40 } };
    expect(leerPendiente(porSocket)).toBe(40);
  });

  it('suspende deltas, manda snapshot al estabilizarse y corta al cliente lento', () => {
    const conexion = {
      bufferedAmount: 200,
      enviados: [],
      enviar(evento) {
        this.enviados.push(evento);
      },
      cerrar(motivo) {
        this.motivo = motivo;
      },
    };
    const snapshots = [];
    let tick = null;
    const motor = crearMotor({
      tamanoLote: 10,
      ventanaMs: 10,
      programar(fn) {
        tick = fn;
        return 1;
      },
      cancelar() {
        tick = null;
      },
      ceder(fn) {
        fn();
      },
      resolverConexiones: (tema) => (tema === 'mun:11' ? [conexion] : []),
      evaluar: (c) => evaluar(c, umbrales),
      enviarSnapshot(c) {
        snapshots.push(c);
        c.enviar('snapshot', { ok: true });
      },
      alDesconectar(c) {
        c.cerrar('lento');
      },
    });

    motor.ingresar(acta('1-0'));
    tick();
    expect(conexion.enviados).toEqual([]);
    expect(conexion.necesitaSnapshot).toBe(true);
    expect(snapshots).toHaveLength(0);

    conexion.bufferedAmount = 0;
    motor.ingresar(acta('2-0'));
    tick();
    expect(snapshots).toHaveLength(1);
    expect(conexion.enviados).toEqual(['snapshot']);
    expect(conexion.necesitaSnapshot).toBe(false);

    conexion.bufferedAmount = 5000;
    motor.ingresar(acta('3-0'));
    tick();
    expect(conexion.motivo).toBe('lento');
    expect(conexion.cerrada).toBe(true);
    expect(conexion.enviados).toEqual(['snapshot']);
  });

  it('el latido fuerza el snapshot cuando el buffer ya bajó', async () => {
    const conexion = {
      topico: 'dep',
      bufferedAmount: 0,
      necesitaSnapshot: true,
      enviados: [],
      enviar(evento, datos) {
        this.enviados.push({ evento, datos });
      },
    };
    revisarPresion(conexion);
    await new Promise((r) => setImmediate(r));
    expect(conexion.necesitaSnapshot).toBe(false);
    expect(conexion.enviados[0]?.evento).toBe('snapshot');
    expect(conexion.enviados[0]?.datos.stream_id).toBeTruthy();
  });
});
