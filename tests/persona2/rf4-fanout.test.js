import { describe, expect, it } from 'vitest';
import { crearMotor } from '../../src/fanout/engine.js';

function acta(parcial = {}) {
  return {
    stream_id: '1-0',
    acta: 'E14-176-0042-03',
    mun: 11,
    pue: 176,
    version: 1,
    tipo: 'nueva',
    ...parcial,
  };
}

function motorCon({ conexiones, topico = 'mun:11', ...resto }) {
  let tick = null;
  const cola = [];
  const motor = crearMotor({
    tamanoLote: 10,
    ventanaMs: 25,
    programar(fn) {
      tick = fn;
      return 1;
    },
    cancelar() {
      tick = null;
    },
    ceder(fn) {
      cola.push(fn);
    },
    resolverConexiones(tema) {
      return tema === topico ? conexiones : [];
    },
    ...resto,
  });
  return {
    motor,
    cola,
    flush() {
      if (!tick) throw new Error('no hay ventana pendiente');
      const fn = tick;
      tick = null;
      fn();
    },
  };
}

describe('RF-4 fan-out por lotes y ventana', () => {
  it('el ceder por defecto es setImmediate', () => {
    expect(crearMotor().ceder).toBe(setImmediate);
  });

  it('envía en lotes de N y solo cede el event loop entre lotes', () => {
    const recibidos = [];
    const conexiones = Array.from({ length: 5 }, (_, i) => ({
      enviar() {
        recibidos.push(i);
      },
    }));
    const cola = [];
    let tick = null;
    const motor = crearMotor({
      tamanoLote: 2,
      ventanaMs: 20,
      programar(fn) {
        tick = fn;
        return 1;
      },
      cancelar() {
        tick = null;
      },
      ceder(fn) {
        cola.push(fn);
      },
      resolverConexiones: (tema) => (tema === 'dep' ? conexiones : []),
    });

    motor.ingresar(acta());
    expect(recibidos).toEqual([]);
    tick();
    expect(recibidos).toEqual([0, 1]);
    expect(cola).toHaveLength(1);
    cola.shift()();
    expect(recibidos).toEqual([0, 1, 2, 3]);
    cola.shift()();
    expect(recibidos).toEqual([0, 1, 2, 3, 4]);
    expect(cola).toHaveLength(0);
    expect(motor.estadisticas().cesiones).toBe(2);
  });

  it('colapsa las repeticiones de una misma acta en un solo delta', () => {
    const enviados = [];
    const conexion = {
      enviar(_evento, datos) {
        enviados.push(datos);
      },
    };
    const { motor, flush } = motorCon({ conexiones: [conexion] });
    motor.ingresar(acta({ version: 1, stream_id: '1-0' }));
    motor.ingresar(acta({ version: 3, tipo: 'correccion', stream_id: '3-0' }));
    motor.ingresar(acta({ version: 2, tipo: 'correccion', stream_id: '2-0' }));
    flush();

    expect(enviados).toHaveLength(1);
    expect(enviados[0].eventos).toHaveLength(1);
    expect(enviados[0].eventos[0]).toMatchObject({ version: 3, stream_id: '3-0' });
    expect(motor.estadisticas()).toMatchObject({ mensajesNaivos: 3, mensajesEmitidos: 1 });
  });

  it('varias actas de la ventana salen en un mensaje, no una por acta', () => {
    const recibidos = [];
    const conexiones = [0, 1, 2].map(() => ({
      enviar(_evento, datos) {
        recibidos.push(datos.eventos.length);
      },
    }));
    const { motor, flush } = motorCon({ conexiones });
    for (let n = 0; n < 4; n += 1) {
      motor.ingresar(
        acta({
          acta: `E14-176-000${n}-03`,
          stream_id: `${n + 1}-0`,
        }),
      );
    }
    flush();
    expect(recibidos).toEqual([4, 4, 4]);
    expect(motor.estadisticas().mensajesNaivos).toBe(12);
    expect(motor.estadisticas().mensajesEmitidos).toBe(3);
  });

  it('retiene los deltas mientras la conexión no está lista y luego los entrega', () => {
    const enviados = [];
    const conexion = {
      acepta: false,
      retenido: [],
      enviar(_evento, datos) {
        enviados.push(datos);
      },
    };
    const { motor, flush } = motorCon({ conexiones: [conexion], topico: 'dep' });
    motor.ingresar(acta());
    flush();
    expect(enviados).toEqual([]);
    expect(conexion.retenido).toHaveLength(1);
    conexion.acepta = true;
    motor.entregar(conexion, conexion.retenido.shift());
    expect(enviados).toHaveLength(1);
    expect(enviados[0].topico).toBe('dep');
  });
});
