/**
 * DOMA CRIOLLA — Control de Stock y Producción
 * Este script va PEGADO en el Google Sheet que actúa de base de datos.
 * Ver INSTRUCCIONES.md para cómo instalarlo y publicarlo.
 *
 * Hojas que espera encontrar en esta misma planilla:
 *   Stock            (se completa sola, un renglón por lote cargado)
 *   Ref_Sabores       (referencia, se actualiza a mano ~1 vez por mes)
 *   Ref_Calendario    (referencia, ídem)
 *   Ref_VentaDiaria   (referencia, ídem)
 */

const TZ = 'America/Argentina/Buenos_Aires';
const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const LOCALES = ['Centro', 'Patagonia', 'Zelarrayan'];
const TIPOS_DISCO = ['Horno', 'Frito', 'Recorte']; // igual que en index.html (Cargar stock de Fábrica - Discos)

// Rubros que se muestran en Cargar Stock y en Producción. Lo que no está acá
// (Ingrediente, DiscosCanastas) queda afuera de ambas pantallas.
const RUBROS_VISIBLES = ['Empanadas Horno', 'Empanadas Frito', 'Dips', 'Postres', 'Toppings', 'Cajita Criolla'];
// Nombre lindo para mostrar, a partir de la Categoria tal cual está en Ref_Sabores.
const NOMBRE_RUBRO = { Dip: 'Dips', Postre: 'Postres', Topping: 'Toppings', CajitaCriolla: 'Cajita Criolla' };

// ---------------------------------------------------------------------------
// Puntos de entrada HTTP
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// VELOCIDAD — resultados de cálculos guardados un rato (30/09/2026).
// Los cálculos pesados (qué producir, envíos, ollas, informes) se guardan en
// la caché de Apps Script con una "versión de los datos". Cada vez que alguien
// guarda algo desde la app (doPost) o edita la planilla a mano (onEdit), la
// versión cambia y los resultados viejos dejan de usarse: nunca se muestra un
// cálculo desactualizado, pero si nadie cargó nada nuevo, abrir de nuevo la
// pantalla (o abrirla desde otra tablet) es casi instantáneo.
// ---------------------------------------------------------------------------
const ACCIONES_CACHEABLES = ['calcularTodo', 'calcularEnvios', 'calcularPrepDiaAnterior', 'calcularOllas',
  'calcularDemandaPreparados', 'calcularInsumosRealesDia', 'obtenerStockAnalisisLocal'];
const CACHE_RESULTADOS_SEG = 600;
let T0 = 0;

function versionDatos() {
  try {
    const c = CacheService.getScriptCache();
    let v = c.get('version_datos');
    if (!v) { v = String(Date.now()); c.put('version_datos', v, 21600); }
    return v;
  } catch (err) { return 'x'; }
}
function cambiarVersionDatos() {
  try { CacheService.getScriptCache().put('version_datos', Date.now() + '-' + Math.floor(Math.random() * 1e6), 21600); } catch (err) {}
}
function hashTexto(t) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, t)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function cacheGuardarTexto(clave, texto, segundos) {
  try {
    const trozos = {};
    let n = 0;
    for (let i = 0; i < texto.length; i += CACHE_TROZO) { trozos[clave + ':' + n] = texto.substring(i, i + CACHE_TROZO); n++; }
    if (n > 50) return;
    trozos[clave + ':n'] = String(n);
    CacheService.getScriptCache().putAll(trozos, segundos);
  } catch (err) {}
}
function cacheLeerTexto(clave) {
  try {
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get(clave + ':n'));
    if (!n) return null;
    const claves = [];
    for (let i = 0; i < n; i++) claves.push(clave + ':' + i);
    const t = cache.getAll(claves);
    let texto = '';
    for (let i = 0; i < n; i++) { if (t[claves[i]] == null) return null; texto += t[claves[i]]; }
    return texto;
  } catch (err) { return null; }
}

function doGet(e) {
  T0 = Date.now();
  const action = e.parameter.action;
  if (ACCIONES_CACHEABLES.indexOf(action) !== -1) {
    const params = Object.keys(e.parameter).sort().map(k => k + '=' + e.parameter[k]).join('&');
    const clave = 'r:' + versionDatos() + ':' + hashTexto(params + '|' + hoy());
    const guardado = cacheLeerTexto(clave);
    if (guardado) {
      const obj = JSON.parse(guardado);
      obj._cache = true;
      return respond(obj);
    }
    const obj = doGetSinCache(e);
    if (obj && !obj.error) cacheGuardarTexto(clave, JSON.stringify(obj), CACHE_RESULTADOS_SEG);
    return respond(obj);
  }
  return respond(doGetSinCache(e));
}

// devuelve el OBJETO de respuesta (doGet lo convierte en JSON)
function doGetSinCache(e) {
  const action = e.parameter.action;
  PLAN_ANCLA = e.parameter.fecha || hoy(); // el plan congelado que vale es el del día que se está mirando
  const respond = obj => obj; // acá adentro "respond" solo devuelve el objeto
  try {
    if (action === 'ping') {
      return respond({ ok: true });
    }
    if (action === 'calcularTodo') {
      const r = calcularTodo(e.parameter.fecha);
      r.plan = estadoPlanDia(e.parameter.fecha || hoy());
      return respond(r);
    }
    if (action === 'calcularEnvios') {
      const r = calcularEnvios(e.parameter.fecha);
      r.plan = estadoPlanDia(e.parameter.fecha || hoy());
      return respond(r);
    }
    if (action === 'listarEnviosPendientes') {
      return respond(listarEnviosPendientes(e.parameter.local));
    }
    if (action === 'obtenerEnviosDia') {
      return respond(obtenerEnviosDia(e.parameter.fecha));
    }
    if (action === 'listarHistorialEnvios') {
      return respond(listarHistorialEnvios(e.parameter.local));
    }
    if (action === 'listarSabores') {
      asegurarProductosBase();
      // agrupado por rubro, para armar el selector de carga. Las empanadas
      // se agrupan en "Empanadas Horno" / "Empanadas Frito" (Canasta entra
      // dentro de Horno, ya que se hornea igual) — el resto por su categoria.
      // Solo se listan los rubros en RUBROS_VISIBLES.
      // categoriaPorSabor: para que el front sepa cuáles son "Canasta" (armado
      // manual del molde) sin tener que adivinarlo por el nombre.
      const refSabores = leerHoja('Ref_Sabores');
      const porCategoria = {};
      const categoriaPorSabor = {};
      refSabores.forEach(s => {
        categoriaPorSabor[s.Sabor] = s.Categoria;
        const rubro = rubroDeSabor(s);
        if (RUBROS_VISIBLES.indexOf(rubro) === -1) return;
        porCategoria[rubro] = porCategoria[rubro] || [];
        porCategoria[rubro].push(s.Sabor);
      });
      return respond({ categorias: ordenarPorCategoria(porCategoria), categoriaPorSabor });
    }
    if (action === 'listarRellenos') {
      // rellenos únicos (para cargar stock de Fábrica - Cocina) — cualquier
      // fila de Ref_Sabores que tenga algo cargado en "Relleno", sin
      // filtrar por TipoCalculo, para que aparezcan TODOS los rellenos
      // (incluidos los que se sumen a futuro con otro TipoCalculo).
      const refSabores = leerHoja('Ref_Sabores');
      const rellenos = [...new Set(
        refSabores.filter(s => String(s.Relleno || '').trim() !== '').map(s => s.Relleno)
      )].sort((a, b) => String(a).localeCompare(String(b)));
      return respond({ rellenos });
    }
    if (action === 'historialStock') {
      return respond({ registros: leerHoja('Stock') });
    }
    if (action === 'limpiarCache') {
      return respond(limpiarCacheHojas());
    }
    if (action === 'listarEmpleados') {
      return respond(listarEmpleados());
    }
    if (action === 'listarPlanificacion') {
      return respond(listarPlanificacion(e.parameter.local));
    }
    if (action === 'listarRecetas') {
      return respond(listarRecetas());
    }
    if (action === 'calcularDemandaPreparados') {
      return respond(calcularDemandaPreparados(e.parameter.fecha));
    }
    if (action === 'calcularPrepDiaAnterior') {
      return respond(calcularPrepDiaAnterior(e.parameter.fecha));
    }
    if (action === 'calcularOllas') {
      return respond(calcularOllas(e.parameter.fecha));
    }
    if (action === 'calcularInsumosRealesDia') {
      return respond(calcularInsumosRealesDia(e.parameter.fecha));
    }
    if (action === 'listarTrazabilidadCocinaDia') {
      return respond(listarTrazabilidadCocinaDia(e.parameter.fecha));
    }
    if (action === 'listarRecetasFinalizadas') {
      return respond(listarRecetasFinalizadas(e.parameter.fecha));
    }
    if (action === 'obtenerRegistroProduccionDia') {
      return respond(obtenerRegistroProduccionDia(e.parameter.fecha));
    }
    if (action === 'obtenerRegistroDiscosDia') {
      return respond(obtenerRegistroDiscosDia(e.parameter.fecha));
    }
    if (action === 'obtenerStockCargadoDia') {
      return respond(obtenerStockCargadoDia(e.parameter.local, e.parameter.fecha));
    }
    if (action === 'obtenerStockAnalisisLocal') {
      return respond(obtenerStockAnalisisLocal(e.parameter.local, e.parameter.fecha));
    }
    return respond({ error: 'Acción GET no reconocida: ' + action });
  } catch (err) {
    return respond({ error: String(err) });
  }
}

// Lista de empleados para los desplegables (Responsable, Repartidor,
// Acompañante, puestos de máquina, etc.) — se administra a mano en la hoja
// "Empleados" (una columna "Nombre", una fila por persona).
function listarEmpleados() {
  const nombres = leerHoja('Empleados').map(f => f.Nombre).filter(Boolean);
  nombres.sort((a, b) => String(a).localeCompare(String(b)));
  return { empleados: nombres };
}

// categorías en el orden de RUBROS_VISIBLES y, dentro de cada una, los
// productos en orden alfabético (pedido por Carolina, 29/09/2026).
function compararTexto(a, b) {
  return String(a).localeCompare(String(b), 'es', { sensitivity: 'base', numeric: true });
}
function ordenarPorCategoria(porCategoria) {
  const out = {};
  const cats = Object.keys(porCategoria).sort((a, b) => {
    const ia = RUBROS_VISIBLES.indexOf(a), ib = RUBROS_VISIBLES.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || compararTexto(a, b);
  });
  cats.forEach(c => { out[c] = porCategoria[c].slice().sort(compararTexto); });
  return out;
}

function rubroDeSabor(s) {
  if (String(s.TipoCalculo).trim() !== 'Calendario') return NOMBRE_RUBRO[s.Categoria] || s.Categoria;
  return s.Categoria === 'Frito' ? 'Empanadas Frito' : 'Empanadas Horno'; // Horno y Canasta -> Empanadas Horno
}

// Todas las escrituras pasan de a una (LockService): si dos tablets guardan
// en el mismo segundo, la segunda espera a que termine la primera — así no
// se pisan filas ni se agregan dos en el mismo renglón.
function doPost(e) {
  T0 = Date.now();
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return respond({ error: 'El sistema está ocupado guardando otra carga — probá de nuevo en unos segundos.' });
  }
  try {
    return doPostSinLock(e);
  } finally {
    cambiarVersionDatos(); // cualquier guardado invalida los cálculos guardados
    lock.releaseLock();
  }
}

function doPostSinLock(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    PLAN_ANCLA = data.fecha || hoy();
    if (data.action === 'confirmarPlanDia') {
      return respond(confirmarPlanDia(data));
    }
    if (data.action === 'registrarStock') {
      return respond(registrarStock(data));
    }
    if (data.action === 'registrarStockItem') {
      return respond(registrarStockItem(data));
    }
    if (data.action === 'actualizarPlanificacion') {
      return respond(actualizarPlanificacion(data));
    }
    if (data.action === 'registrarEnvio') {
      return respond(registrarEnvio(data));
    }
    if (data.action === 'confirmarRecepcion') {
      return respond(confirmarRecepcion(data));
    }
    if (data.action === 'registrarTrazabilidadProduccion') {
      return respond(registrarTrazabilidadProduccion(data));
    }
    if (data.action === 'reabrirTurnoProduccion') {
      return respond(reabrirTurnoProduccion(data));
    }
    if (data.action === 'registrarTrazabilidadItem') {
      return respond(registrarTrazabilidadItem(data));
    }
    if (data.action === 'registrarTrazabilidadDiscosItem') {
      return respond(registrarTrazabilidadDiscosItem(data));
    }
    if (data.action === 'registrarTrazabilidadCocinaItem') {
      return respond(registrarTrazabilidadCocinaItem(data));
    }
    if (data.action === 'guardarPorcentajeCocina') {
      return respond(guardarPorcentajeCocina(data));
    }
    if (data.action === 'finalizarRecetaCocina') {
      return respond(finalizarRecetaCocina(data));
    }
    if (data.action === 'reabrirRecetaCocina') {
      return respond(reabrirRecetaCocina(data));
    }
    if (data.action === 'registrarTrazabilidadDiscosLote') {
      return respond(registrarTrazabilidadDiscosLote(data));
    }
    if (data.action === 'registrarTrazabilidadCocinaLote') {
      return respond(registrarTrazabilidadCocinaLote(data));
    }
    if (data.action === 'confirmarEntregaTraspaso') {
      return respond(confirmarEntregaTraspaso(data));
    }
    if (data.action === 'reabrirCarga') {
      return respond(reabrirCarga(data));
    }
    if (data.action === 'importarFichaTecnica') {
      return respond(importarFichaTecnica(data));
    }
    return respond({ error: 'Acción POST no reconocida: ' + data.action });
  } catch (err) {
    return respond({ error: String(err) });
  }
}

function respond(obj) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && T0) obj._ms = Date.now() - T0; // tiempo en el servidor
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Registrar stock (lo que carga cada local o fábrica)
// ---------------------------------------------------------------------------

/**
 * data = {
 *   local: 'Centro' | 'Patagonia' | 'Zelarrayan' | 'Fábrica - Producción' |
 *          'Fábrica - Cocina' | 'Fábrica - Discos',
 *   responsable: 'Nombre de quién carga',
 *   fecha: 'yyyy-MM-dd' (opcional, default hoy),
 *   items: [ { sabor: 'Pollo H', cantidad: 24, vencimiento: 'yyyy-MM-dd' }, ... ]
 * }
 * Cada item es UN LOTE. Un mismo sabor puede tener varias líneas (varios lotes
 * con vencimientos distintos conviviendo) — por eso "items" es una lista.
 * Se guarda en la hoja Stock: Fecha_registro, Local, Sabor, Cantidad,
 * Fecha_vencimiento, Responsable.
 *
 * Se identifica cada lote por Fecha_registro+Local+Sabor+Fecha_vencimiento —
 * volver a guardar el mismo lote el mismo día (por ejemplo después de tocar
 * "Editar") pisa esa fila en vez de duplicarla. Antes esto agregaba una fila
 * nueva siempre; se cambió a upsert porque ahora cada ítem se puede guardar
 * suelto con su propio botón (ver registrarStockItem) — sin upsert, guardar
 * dos veces el mismo lote (por corregir un typo) sumaba el stock dos veces.
 * Confirmado con Carolina (26/09/2026).
 */
function registrarStock(data) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Stock');
  const headers = headersDe(sheet);
  const fechaRegistro = data.fecha || hoy();
  // primero se borra lo que estaba guardado y se dejó en blanco (o se quitó con ✕)
  const borrados = borrarFilasPorClaves(sheet, headers, (data.borrar || []).map(b => (
    { Fecha_registro: fechaRegistro, Local: data.local, Sabor: b.sabor, Fecha_vencimiento: b.vencimiento }
  )));
  const r = upsertVarias(sheet, headers, (data.items || []).map(item => ({
    claves: { Fecha_registro: fechaRegistro, Local: data.local, Sabor: item.sabor, Fecha_vencimiento: ('vencimientoAnterior' in item) ? item.vencimientoAnterior : item.vencimiento },
    fila: filaStockItem(fechaRegistro, data.local, item, data.responsable, headers)
  })));
  const actualizados = r.actualizadas;
  // total de lotes que quedaron guardados para ese local ese día (para el
  // mensaje de confirmación en pantalla)
  const totalDia = leerTabla(sheet).values.slice(1).filter(row =>
    row[headers.indexOf('Local')] === data.local && normalizarFecha(row[headers.indexOf('Fecha_registro')]) === normalizarFecha(fechaRegistro)
  ).length;
  // "Guardar y enviar": además de guardar, deja la carga CERRADA (hoja Cierres)
  let cierre = null;
  if (data.enviar) cierre = registrarCierre(fechaRegistro, 'Stock', data.local, data.responsable, totalDia);
  return { ok: true, registros_guardados: (data.items || []).length, actualizados, borrados, total_dia: totalDia, cierre };
}

// arma una fila de Stock a partir de un item — la usan tanto el guardado
// "por lote" (apenas se carga, con su propio botón) como el guardado de
// todo lo que haya quedado sin guardar individualmente.
function filaStockItem(fecha, local, item, responsable, headers) {
  const fila = new Array(headers.length).fill('');
  setPorHeader(fila, headers, 'Fecha_registro', fecha);
  setPorHeader(fila, headers, 'Local', local);
  setPorHeader(fila, headers, 'Sabor', item.sabor);
  setPorHeader(fila, headers, 'Cantidad', Number(item.cantidad) || 0);
  setPorHeader(fila, headers, 'Fecha_vencimiento', item.vencimiento);
  setPorHeader(fila, headers, 'Responsable', responsable || '');
  return fila;
}

/**
 * Guarda (o actualiza) UN lote apenas se termina de cargar, sin esperar a
 * completar toda la lista — así, si alguien se equivoca al tipear en la
 * tablet, corrige y reguarda solo ese ítem, sin tener que repetir todo lo
 * demás. data = { local, fecha (opcional), responsable, item: { sabor,
 * cantidad, vencimiento } }.
 */
function registrarStockItem(data) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Stock');
  const headers = headersDe(sheet);
  const fecha = data.fecha || hoy();
  const item = data.item || {};
  // vencimientoAnterior: si se tocó "Editar" y se cambió el vencimiento, hay
  // que pisar la fila con el vencimiento VIEJO (si no, quedaba el lote viejo
  // y además uno nuevo — el stock se duplicaba).
  const claves = { Fecha_registro: fecha, Local: data.local, Sabor: item.sabor, Fecha_vencimiento: ('vencimientoAnterior' in item) ? item.vencimientoAnterior : item.vencimiento };
  const fila = filaStockItem(fecha, data.local, item, data.responsable, headers);
  const r = upsertFila(sheet, headers, claves, fila);
  return { ok: true, actualizado: r.actualizado };
}

// lo que YA se guardó hoy para este local (para prellenar/bloquear esas
// filas al recargar "Cargar stock", igual que en Registrar producción).
function obtenerStockCargadoDia(local, fechaParam) {
  const fecha = fechaParam || hoy();
  const filas = leerHojaParaFecha('Stock', 'Fecha_registro', fecha).filter(f => f.Local === local && normalizarFecha(f.Fecha_registro) === normalizarFecha(fecha));
  return {
    local,
    fecha,
    cierre: obtenerCierre(fecha, 'Stock', local),
    items: filas.map(f => ({
      sabor: f.Sabor,
      cantidad: valorCelda(f.Cantidad),
      vencimiento: valorCelda(f.Fecha_vencimiento),
      responsable: valorCelda(f.Responsable)
    }))
  };
}

/**
 * Informe "Análisis stock local": TODOS los productos visibles (mismo
 * universo que "Cargar stock"), agrupados por categoría, con el stock
 * ACTUAL de ese local — la carga más reciente de cada producto (igual
 * criterio que stockVigente: por sabor, no por local entero, para que un
 * producto recargado un día distinto de los demás igual muestre lo último
 * que se cargó de ÉL). Cada lote trae su cantidad, vencimiento, y un
 * "estado" para que la web lo resalte en rojo/rosa/verde según la fecha de
 * consulta (fechaParam): vencido (ya pasó), vence_hoy (vence justo ese día),
 * vence_manana (vence al día siguiente), u ok. Confirmado con Carolina
 * (27/09/2026).
 */
function obtenerStockAnalisisLocal(local, fechaParam) {
  const fechaConsulta = fechaParam || hoy();
  const fechaDeFila = st => normalizarFecha(st.Fecha_registro);
  // solo cargas hechas hasta la fecha de consulta (para poder mirar días anteriores)
  const stock = leerHojaParaFecha('Stock', 'Fecha_registro', sumarDias(fechaConsulta, -1)).filter(st => st.Local === local && fechaDeFila(st) <= fechaConsulta);
  const refSabores = leerHoja('Ref_Sabores');

  // MISMO criterio que los cálculos (stockParaFecha): cuenta la carga de la
  // fecha de consulta o la de la noche anterior; lo que no figura es 0, y si
  // no hay ninguna de las dos, todo el lugar está en 0.
  const efectivas = stockParaFecha(stock, fechaConsulta);
  const fechaCargaVigente = efectivas.length ? fechaDeFila(efectivas[0]) : null;
  let ultimaCarga = null;
  if (fechaCargaVigente) {
    const cierre = obtenerCierre(fechaCargaVigente, 'Stock', local);
    ultimaCarga = {
      fecha: fechaCargaVigente,
      responsable: String(efectivas[efectivas.length - 1].Responsable || ''),
      productos: new Set(efectivas.map(st => st.Sabor)).size,
      enviada: !!cierre,
      hora: cierre ? cierre.hora : ''
    };
  }
  // si no hay carga vigente: cuál fue la última (vieja, ya no cuenta)
  let cargaVieja = null;
  if (!fechaCargaVigente) stock.forEach(st => { const f = fechaDeFila(st); if (!cargaVieja || f > cargaVieja) cargaVieja = f; });

  const lotesPorSabor = {};
  efectivas.forEach(st => {
    lotesPorSabor[st.Sabor] = lotesPorSabor[st.Sabor] || [];
    lotesPorSabor[st.Sabor].push({
      cantidad: Number(st.Cantidad) || 0,
      vencimiento: normalizarFecha(st.Fecha_vencimiento)
    });
  });

  const fechaManana = sumarDias(fechaConsulta, 1);
  function estadoDeVencimiento(venc) {
    if (!venc) return 'ok';
    if (venc < fechaConsulta) return 'vencido';
    if (venc === fechaConsulta) return 'vence_hoy';
    if (venc === fechaManana) return 'vence_manana';
    return 'ok';
  }

  // qué productos se listan: los mismos que en "Cargar stock" de ese lugar —
  // sabores (locales y Fábrica - Producción), rellenos (Fábrica - Cocina, en
  // kilos) o tipos de disco (Fábrica - Discos, en docenas).
  const listado = []; // [{ categoria, nombre }]
  if (local === 'Fábrica - Cocina') {
    [...new Set(refSabores.filter(s => String(s.Relleno || '').trim() !== '').map(s => s.Relleno))]
      .sort((a, b) => String(a).localeCompare(String(b)))
      .forEach(n => listado.push({ categoria: 'Rellenos', nombre: n }));
  } else if (local === 'Fábrica - Discos') {
    TIPOS_DISCO.forEach(n => listado.push({ categoria: 'Discos', nombre: n }));
  } else {
    refSabores.forEach(s => {
      const rubro = rubroDeSabor(s);
      if (RUBROS_VISIBLES.indexOf(rubro) === -1) return;
      listado.push({ categoria: rubro, nombre: s.Sabor });
    });
  }

  listado.sort((a, b) => {
    const ia = RUBROS_VISIBLES.indexOf(a.categoria), ib = RUBROS_VISIBLES.indexOf(b.categoria);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || compararTexto(a.nombre, b.nombre);
  });
  const porCategoria = {};
  listado.forEach(({ categoria, nombre }) => {
    porCategoria[categoria] = porCategoria[categoria] || [];
    const lotes = (lotesPorSabor[nombre] || []).map(l => ({
      cantidad: l.cantidad,
      vencimiento: l.vencimiento,
      estado: estadoDeVencimiento(l.vencimiento)
    }));
    porCategoria[categoria].push({
      sabor: nombre,
      fechaCarga: fechaCargaVigente,
      // no figura en la carga vigente -> 0
      ceroEnCarga: !lotesPorSabor[nombre],
      lotes
    });
  });

  const unidad = local === 'Fábrica - Cocina' ? 'kg' : local === 'Fábrica - Discos' ? 'docenas' : 'unidades';
  return { local, fecha: fechaConsulta, dia: diaSemana(fechaConsulta), ultimaCarga, cargaVieja, unidad, categorias: porCategoria };
}

// ---------------------------------------------------------------------------
// Envíos: lo que Fábrica despacha a cada local, y lo que el local confirma
// haber recibido. Queda en la hoja "Envios" (una fila por producto por
// envío) para trazabilidad (enviado vs recibido) — esto NO carga stock
// automáticamente: el local sigue cargando su stock a mano en "Cargar
// stock", como hasta ahora.
// ---------------------------------------------------------------------------

/**
 * data = {
 *   local: 'Centro' | 'Patagonia' | 'Zelarrayan',
 *   responsable: 'Nombre de quién despacha',
 *   fecha: 'yyyy-MM-dd' (opcional, default hoy),
 *   items: [ { sabor, cantidad, vencimiento }, ... ]
 * }
 * Una fila por producto enviado, con un ID único. Las columnas de recepción
 * quedan vacías hasta que el local confirme con confirmarRecepcion().
 */
/**
 * Guarda (o ACTUALIZA, si ya existía) uno o varios ítems de un envío. Se usa
 * tanto para el guardado individual por sabor/lote como para el "Guardar
 * despacho" del resto — la clave Fecha_envio+Local+Sabor+Vencimiento es lo
 * que identifica una fila ya existente, así que volver a guardar lo mismo
 * (después de tocar "Editar") pisa esa fila en vez de duplicarla. Si el
 * local ya había confirmado recepción de esa fila, esa recepción NO se
 * borra al editar el lado del envío.
 */
// Columna "Estado" (se agrega sola): 'Preparando' mientras Fábrica arma el
// despacho con guardados provisorios, 'Enviado' recién al tocar "Guardar y
// enviar" — el local solo ve en "Confirmar recepción" lo Enviado (o las filas
// viejas, de antes de que existiera esta columna, que quedan vacías).
// hoja Envios con las columnas nuevas (se agregan solas si faltan):
//   Estado            'Preparando' / 'Enviado'
//   Origen            vacío = sale de Fábrica; un local = TRASPASO de ese local
//   Fecha_entrega_origen / Responsable_entrega_origen: el local de origen
//                     confirma que entregó la mercadería del traspaso
function hojaEnvios() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Envios');
  let headers = headersDe(sheet);
  ['Estado', 'Origen', 'Fecha_entrega_origen', 'Responsable_entrega_origen'].forEach(c => {
    if (headers.indexOf(c) === -1) headers = asegurarColumna(sheet, c);
  });
  return { sheet, headers };
}

// data = { origen ('' = Fábrica, o un local si es traspaso), local (destino),
//          fecha, responsable, repartidor, acompanante,
//          items: [{ sabor, cantidad, vencimiento, vencimientoAnterior? }],
//          borrar: [{ sabor, vencimiento }], enviar }
function registrarEnvio(data) {
  const { sheet, headers } = hojaEnvios();
  const fechaEnvio = data.fecha || hoy();
  const origen = data.origen || '';
  const camposRecepcion = ['ID', 'Fecha_recepcion', 'Cantidad_Recibida', 'Responsable_Recepcion', 'Fecha_entrega_origen', 'Responsable_entrega_origen'];

  // 1) lo que estaba guardado y se dejó en blanco se borra (salvo que el
  //    local ya lo haya recibido: eso no se toca)
  const cRecep = headers.indexOf('Fecha_recepcion');
  const pedidosBorrar = (data.borrar || []).map(b => ({ Fecha_envio: fechaEnvio, Local: data.local, Origen: origen, Sabor: b.sabor, Vencimiento: b.vencimiento }));
  const borrados = borrarFilasPorClaves(sheet, headers, pedidosBorrar, vieja => !vieja[cRecep]);
  const noBorrados = pedidosBorrar.length - borrados;

  // 2) upsert de todo lo cargado
  const pares = (data.items || []).map(item => {
    const fila = new Array(headers.length).fill('');
    setPorHeader(fila, headers, 'Fecha_envio', fechaEnvio);
    setPorHeader(fila, headers, 'Local', data.local);
    setPorHeader(fila, headers, 'Origen', origen);
    setPorHeader(fila, headers, 'Sabor', item.sabor);
    setPorHeader(fila, headers, 'Cantidad_Enviada', Number(item.cantidad));
    setPorHeader(fila, headers, 'Vencimiento', item.vencimiento);
    setPorHeader(fila, headers, 'Responsable_Envio', data.responsable || '');
    setPorHeader(fila, headers, 'Repartidor', data.repartidor || '');
    setPorHeader(fila, headers, 'Acompanante', data.acompanante || '');
    setPorHeader(fila, headers, 'Estado', 'Preparando');
    return { claves: { Fecha_envio: fechaEnvio, Local: data.local, Origen: origen, Sabor: item.sabor, Vencimiento: item.vencimientoAnterior || item.vencimiento }, fila };
  });
  // conservar ID y lo que ya hayan cargado los locales (recepción / entrega)
  const r = upsertVarias(sheet, headers, pares, (fila, vieja) => {
    camposRecepcion.forEach(c => {
      const col = headers.indexOf(c);
      if (col === -1) return;
      fila[col] = vieja ? vieja[col] : (c === 'ID' ? Utilities.getUuid() : '');
    });
  });

  // 3) "Guardar y enviar final": pasa TODO ese despacho a Enviado (recién ahí
  //    los locales lo ven) y deja registrado el cierre.
  const colEstado = headers.indexOf('Estado'), colLocal = headers.indexOf('Local');
  const colFecha = headers.indexOf('Fecha_envio'), colOrigen = headers.indexOf('Origen');
  const tabla = leerTabla(sheet);
  const values = tabla.values;
  let totalDia = 0;
  const cambiadas = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i][colLocal] !== data.local || String(values[i][colOrigen] || '') !== origen || normalizarFecha(values[i][colFecha]) !== normalizarFecha(fechaEnvio)) continue;
    totalDia++;
    if (data.enviar && values[i][colEstado] !== 'Enviado') { values[i][colEstado] = 'Enviado'; cambiadas.push(i); }
  }
  escribirBloque(sheet, tabla, cambiadas, colEstado, colEstado);
  let cierre = null;
  if (data.enviar) cierre = registrarCierre(fechaEnvio, 'Envios', origen ? origen + '>' + data.local : data.local, data.responsable, totalDia);
  return { ok: true, envios_guardados: (data.items || []).length, actualizados: r.actualizadas, borrados, no_borrados: noBorrados, total_dia: totalDia, cierre };
}

// Lo ya guardado en "Despachar envíos" para una fecha: por local (lo que
// manda Fábrica) y los traspasos entre locales ("Origen>Destino").
function obtenerEnviosDia(fechaParam) {
  const fecha = fechaParam || hoy();
  const filas = leerHojaParaFecha('Envios', 'Fecha_envio', fecha).filter(f => normalizarFecha(f.Fecha_envio) === normalizarFecha(fecha));
  const armar = (lista, clave) => {
    const primera = lista[0] || {};
    return {
      responsable: valorCelda(primera.Responsable_Envio),
      repartidor: valorCelda(primera.Repartidor),
      acompanante: valorCelda(primera.Acompanante),
      cierre: obtenerCierre(fecha, 'Envios', clave),
      items: lista.map(f => ({
        sabor: f.Sabor,
        cantidad: valorCelda(f.Cantidad_Enviada),
        vencimiento: valorCelda(f.Vencimiento),
        recibido: !!f.Fecha_recepcion
      }))
    };
  };
  const porLocal = {};
  LOCALES.forEach(local => {
    porLocal[local] = armar(filas.filter(f => f.Local === local && !f.Origen), local);
  });
  const traspasos = {};
  LOCALES.forEach(origen => LOCALES.forEach(destino => {
    if (origen === destino) return;
    const lista = filas.filter(f => f.Local === destino && f.Origen === origen);
    const clave = origen + '>' + destino;
    const cierre = obtenerCierre(fecha, 'Envios', clave);
    if (lista.length || cierre) traspasos[clave] = armar(lista, clave);
  }));
  return { fecha, porLocal, traspasos };
}

// busca una fila existente cuyas columnas coincidan con "claves" (objeto
// {NombreColumna: valor}). Devuelve {rowIndex, values} (rowIndex es
// 0-based, tal cual getDataRange().getValues()) o null si no hay ninguna.
function buscarFila(sheet, headers, claves) {
  const values = sheet.getDataRange().getValues();
  const cols = Object.keys(claves).map(k => ({ col: headers.indexOf(k), val: claves[k] }));
  if (cols.some(c => c.col === -1)) return null;
  // normalizarFecha() de paso también sirve acá para cualquier clave que NO
  // sea fecha (un Date nunca aparece en una columna de texto/nombre), así
  // que compararlo con esta función para TODAS las claves es seguro.
  for (let i = 1; i < values.length; i++) {
    if (cols.every(c => normalizarFecha(values[i][c.col]) === normalizarFecha(c.val))) {
      return { rowIndex: i, values: values[i] };
    }
  }
  return null;
}

// guarda "nuevaFila" pisando la fila existente que matchee "claves", o la
// agrega al final si no había ninguna — así "editar y volver a guardar" no
// duplica filas.
function upsertFila(sheet, headers, claves, nuevaFila) {
  const existente = buscarFila(sheet, headers, claves);
  if (existente) {
    sheet.getRange(existente.rowIndex + 1, 1, 1, headers.length).setValues([nuevaFila]);
    return { actualizado: true };
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, headers.length).setValues([nuevaFila]);
  return { actualizado: false };
}

// Como upsertFila(), pero para MUCHAS filas de una vez: lee la hoja UNA sola
// vez (antes se releía entera por cada ítem — con 40 lotes eran 40 lecturas
// de toda la hoja), pisa las que ya existían y agrega las nuevas todas juntas
// en una sola escritura. pares = [{ claves, fila }]. alPisar(filaNueva,
// filaVieja) opcional, para conservar columnas de la fila existente.
function upsertVarias(sheet, headers, pares, alPisar) {
  if (!pares.length) return { actualizadas: 0, nuevas: 0 };
  const tabla = leerTabla(sheet);
  const values = tabla.values;
  const nombres = Object.keys(pares[0].claves);
  const cols = nombres.map(n => headers.indexOf(n));
  if (cols.some(c => c === -1)) throw new Error('Faltan columnas en la hoja ' + sheet.getName() + ': ' + nombres.join(', '));
  const claveDe = vals => cols.map(c => normalizarFecha(vals[c])).join('\u0001');
  const indice = {};
  for (let i = 1; i < values.length; i++) indice[claveDe(values[i])] = i;
  const nuevas = [];
  let actualizadas = 0;
  pares.forEach(p => {
    const k = nombres.map(n => normalizarFecha(p.claves[n])).join('\u0001');
    const i = indice[k];
    if (typeof i === 'string') { // repetido dentro del mismo pedido: gana el último
      nuevas[Number(i.slice(1))] = p.fila;
      return;
    }
    if (i !== undefined) {
      if (alPisar) alPisar(p.fila, values[i]);
      sheet.getRange(tabla.filaDe(i), 1, 1, headers.length).setValues([p.fila]);
      actualizadas++;
    } else {
      if (alPisar) alPisar(p.fila, null);
      nuevas.push(p.fila);
      indice[k] = 'n' + (nuevas.length - 1); // por si viene repetido en el mismo pedido
    }
  });
  if (nuevas.length) sheet.getRange(sheet.getLastRow() + 1, 1, nuevas.length, headers.length).setValues(nuevas);
  return { actualizadas, nuevas: nuevas.length };
}

// Borra las filas que coincidan con alguna de las claves (lista de objetos
// {Columna: valor}). Se usa cuando algo que estaba guardado se deja en blanco
// y se vuelve a guardar: "lo que se ve en pantalla es lo que queda en la
// planilla". filtroExtra(filaVieja) opcional: false = no borrar esa fila.
function borrarFilasPorClaves(sheet, headers, listaClaves, filtroExtra) {
  if (!listaClaves || !listaClaves.length) return 0;
  const tabla = leerTabla(sheet);
  const values = tabla.values;
  const nombres = Object.keys(listaClaves[0]);
  const cols = nombres.map(n => headers.indexOf(n));
  if (cols.some(c => c === -1)) return 0;
  const buscadas = new Set(listaClaves.map(cl => nombres.map(n => normalizarFecha(cl[n])).join('\u0001')));
  const aBorrar = [];
  for (let i = 1; i < values.length; i++) {
    const k = cols.map(c => normalizarFecha(values[i][c])).join('\u0001');
    if (buscadas.has(k) && (!filtroExtra || filtroExtra(values[i]))) aBorrar.push(tabla.filaDe(i));
  }
  aBorrar.sort((a, b) => b - a).forEach(r => sheet.deleteRow(r)); // de abajo para arriba
  return aBorrar.length;
}

// agrega sola una columna nueva al final de una hoja YA EXISTENTE si todavía
// no la tiene (para no depender de que Carolina la agregue a mano en la
// planilla cada vez que suma un campo nuevo). Devuelve los headers
// actualizados. Si la columna ya existe, no toca nada.
function asegurarColumna(sheet, nombreColumna) {
  const headers = headersDe(sheet);
  if (headers.indexOf(nombreColumna) !== -1) return headers;
  const col = headers.length + 1;
  sheet.getRange(1, col).setValue(nombreColumna);
  headers.push(nombreColumna);
  return headers;
}

// como normalizarFecha(), pero para CUALQUIER celda que se vaya a devolver
// tal cual a un <input> del navegador (fecha, hora, texto libre): Sheets
// puede haber autodetectado el valor como Date, incluso para un <input
// type="time"> ("14:30" queda guardado como un Date con la fecha 30/12/1899,
// el "día cero" de Sheets) — sin esto, ese valor volvería como un Date de
// Apps Script serializado raro en vez del texto que el <input> espera.
function valorCelda(v) {
  if (v instanceof Date) {
    if (v.getFullYear() === 1899) return Utilities.formatDate(v, TZ, 'HH:mm');
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  return v == null ? '' : String(v);
}

// Envíos de un local que todavía no confirmó recepción (Fecha_recepcion vacía).
function listarEnviosPendientes(local) {
  const todas = leerHoja('Envios');
  // lo que llega al local (de Fábrica o traspaso de otro local); lo que
  // todavía se está preparando (sin "Guardar y enviar final") no se muestra
  const pendientes = todas.filter(f => f.Local === local && !f.Fecha_recepcion && f.Estado !== 'Preparando');
  pendientes.forEach(f => { f.Origen = f.Origen || ''; });
  pendientes.sort((a, b) => compararTexto(a.Sabor, b.Sabor));
  // lo que SALE del local hacia otro (traspaso) y el local todavía no
  // confirmó haber entregado
  const salidas = todas.filter(f => f.Origen === local && f.Estado === 'Enviado' && !f.Fecha_entrega_origen);
  salidas.sort((a, b) => compararTexto(a.Sabor, b.Sabor));
  return { local, pendientes, salidas };
}

// el local de origen confirma que entregó la mercadería del traspaso.
// data = { local, responsable, fecha, ids: [..] }
function confirmarEntregaTraspaso(data) {
  const { sheet, headers } = hojaEnvios();
  const tabla = leerTabla(sheet);
  const values = tabla.values;
  const cId = headers.indexOf('ID'), cOrigen = headers.indexOf('Origen');
  const cF = headers.indexOf('Fecha_entrega_origen'), cR = headers.indexOf('Responsable_entrega_origen');
  const ids = new Set(data.ids || []);
  const cambiadas = [];
  for (let i = 1; i < values.length; i++) {
    if (ids.has(values[i][cId]) && values[i][cOrigen] === data.local) {
      values[i][cF] = data.fecha || hoy();
      values[i][cR] = data.responsable || '';
      cambiadas.push(i);
    }
  }
  escribirBloque(sheet, tabla, cambiadas, Math.min(cF, cR), Math.max(cF, cR));
  return { ok: true, confirmados: cambiadas.length };
}

/**
 * data = {
 *   local: 'Centro' | 'Patagonia' | 'Zelarrayan',
 *   responsable: 'Nombre de quién recibe',
 *   fecha: 'yyyy-MM-dd' (opcional, default hoy),
 *   confirmaciones: [ { id, cantidadRecibida }, ... ]
 * }
 * Busca cada fila por ID (validando que sea del local que confirma) y le
 * completa Fecha_recepcion, Cantidad_Recibida y Responsable_Recepcion.
 */
function confirmarRecepcion(data) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Envios');
  const tabla = leerTabla(sheet);
  const values = tabla.values;
  const headers = values[0];
  const colId = headers.indexOf('ID');
  const colLocal = headers.indexOf('Local');
  const colFechaRecepcion = headers.indexOf('Fecha_recepcion');
  const colCantidadRecibida = headers.indexOf('Cantidad_Recibida');
  const colResponsableRecepcion = headers.indexOf('Responsable_Recepcion');
  const fechaRecepcion = data.fecha || hoy();

  const filaPorId = {};
  for (let i = 1; i < values.length; i++) if (values[i][colLocal] === data.local) filaPorId[values[i][colId]] = i;
  const cambiadas = [];
  (data.confirmaciones || []).forEach(c => {
    const i = filaPorId[c.id];
    if (i === undefined) return;
    // "Guardado provisorio": guarda la cantidad recibida pero SIN fecha de
    // recepción — el envío sigue pendiente hasta "Guardar y confirmar recepción".
    if (!data.provisorio) values[i][colFechaRecepcion] = fechaRecepcion;
    values[i][colCantidadRecibida] = Number(c.cantidadRecibida) || 0;
    values[i][colResponsableRecepcion] = data.responsable || '';
    cambiadas.push(i);
  });
  const cols = [colFechaRecepcion, colCantidadRecibida, colResponsableRecepcion];
  escribirBloque(sheet, tabla, cambiadas, Math.min.apply(null, cols), Math.max.apply(null, cols));
  return { ok: true, confirmados: cambiadas.length, provisorio: !!data.provisorio };
}

// helper: arma una fila usando el nombre de columna en vez del índice fijo,
// así no importa el orden exacto de las columnas en la hoja "Envios".
function setPorHeader(fila, headers, nombre, valor) {
  const i = headers.indexOf(nombre);
  if (i !== -1) fila[i] = valor;
}

// ---------------------------------------------------------------------------
// HISTORIAL DE ENVÍOS: enviado vs. recibido, para ver diferencias.
// Es de solo lectura — lee la hoja "Envios" tal cual la dejaron
// registrarEnvio() y confirmarRecepcion(), no toca ningún cálculo.
// ---------------------------------------------------------------------------
function listarHistorialEnvios(local) {
  let filas = leerHoja('Envios');
  if (local) filas = filas.filter(f => f.Local === local);

  filas.forEach(f => {
    f.Fecha_envio = formatFecha(f.Fecha_envio);
    f.Vencimiento = formatFecha(f.Vencimiento);
    f.Fecha_recepcion = formatFecha(f.Fecha_recepcion);
    const enviada = Number(f.Cantidad_Enviada) || 0;
    const confirmado = !!f.Fecha_recepcion;
    f.Diferencia = confirmado ? redondear((Number(f.Cantidad_Recibida) || 0) - enviada) : null;
  });

  // más reciente primero
  filas.sort((a, b) => String(b.Fecha_envio).localeCompare(String(a.Fecha_envio)) || String(a.Sabor).localeCompare(String(b.Sabor)));

  return { local: local || 'Todos', envios: filas };
}

// formatea un valor de fecha que puede venir como Date (Sheets lo autoconvierte)
// o como texto 'yyyy-MM-dd' — para mostrar siempre parejo en la web.
function formatFecha(v) {
  if (!v) return '';
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v);
}

// ---------------------------------------------------------------------------
// TRAZABILIDAD — SECTOR PRODUCCIÓN. Basado en la planilla en papel "Registro
// de Producción y Trazabilidad": va en DOS hojas —
//   TrazabilidadTurno       una fila por turno/día: quién ocupó cada puesto
//                           en cada máquina, y las observaciones generales.
//   TrazabilidadProduccion  una fila por cada sabor que SÍ se armó ese turno
//                           (los que no se tocan ese día no generan fila).
// ---------------------------------------------------------------------------

// arma una fila de TrazabilidadProduccion a partir de un item — la usan
// tanto el guardado "por sabor" (durante el turno) como el cierre de turno
// (para los sabores que hayan quedado sin guardar con su propio botón).
function filaTrazabilidadItem(fecha, it, headersDet) {
  const fila = new Array(headersDet.length).fill('');
  setPorHeader(fila, headersDet, 'Fecha', fecha);
  setPorHeader(fila, headersDet, 'Sabor', it.sabor);
  setPorHeader(fila, headersDet, 'MaquinaNumero', it.maquinaNumero || '');
  // Responsable: para las Canastas (Pastel de Papa, Carne y Queso, Carbonara)
  // el armado del molde es trabajo manual, no de máquina — ahí va quién lo
  // hizo en vez del número de máquina.
  setPorHeader(fila, headersDet, 'Responsable', it.responsable || '');
  setPorHeader(fila, headersDet, 'MaquinaVelocidad', it.maquinaVelocidad || '');
  setPorHeader(fila, headersDet, 'DiscosLote', it.discosLote || '');
  setPorHeader(fila, headersDet, 'PesoPromTandaDiscos', Number(it.pesoPromTandaDiscos) || '');
  setPorHeader(fila, headersDet, 'RellenoFecha', it.rellenoFecha || '');
  setPorHeader(fila, headersDet, 'PesoInicialRelleno', Number(it.pesoInicialRelleno) || '');
  setPorHeader(fila, headersDet, 'PesoFinalRelleno', Number(it.pesoFinalRelleno) || '');
  setPorHeader(fila, headersDet, 'HoraInicio', it.horaInicio || '');
  setPorHeader(fila, headersDet, 'HoraFin', it.horaFin || '');
  setPorHeader(fila, headersDet, 'TotalProduccion', Number(it.totalProduccion) || 0);
  setPorHeader(fila, headersDet, 'DiscosDanados', Number(it.discosDanados) || 0);
  return fila;
}

/**
 * Guarda (o actualiza, si ya se había guardado y se tocó "Editar") UN sabor
 * apenas se termina de armar, sin esperar al cierre del turno (las máquinas
 * son 2 y distintas personas van completando distintos sabores a lo largo
 * del turno). Se identifica por Fecha+Sabor — como hay un solo registro por
 * sabor por día, volver a guardar el mismo sabor ese día pisa esa fila en
 * vez de duplicarla.
 * data = { fecha: 'yyyy-MM-dd' (opcional, default hoy), item: {...} }
 */
function registrarTrazabilidadItem(data) {
  const fecha = data.fecha || hoy();
  const sheetDet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('TrazabilidadProduccion');
  const headersDet = headersDe(sheetDet);
  const item = data.item || {};
  const fila = filaTrazabilidadItem(fecha, item, headersDet);
  const r = upsertFila(sheetDet, headersDet, { Fecha: fecha, Sabor: item.sabor }, fila);
  return { ok: true, actualizado: r.actualizado };
}

/**
 * Cierre del turno: guarda los puestos de cada máquina + las observaciones
 * generales (una sola vez), y de paso cualquier sabor que haya quedado sin
 * guardar con su propio botón durante el turno.
 * data = {
 *   fecha: 'yyyy-MM-dd' (opcional, default hoy),
 *   maquina1: { entrada, relleno, salida },
 *   maquina2: { entrada, relleno, salida },
 *   observaciones: 'texto libre',
 *   items: [ { sabor, maquinaNumero, maquinaVelocidad, discosLote,
 *              pesoPromTandaDiscos, rellenoFecha, pesoInicialRelleno,
 *              pesoFinalRelleno, horaInicio, horaFin, totalProduccion,
 *              discosDanados }, ... ]  (solo los NO guardados todavía)
 * }
 */
// Llamar a esta función ES "cerrar el turno": deja todo el registro de
// Producción de ese día marcado como Finalizado (bloqueado en la web), hasta
// que se toque "Reabrir" (ver reabrirTurnoProduccion). Confirmado con
// Carolina (26/09/2026).
function registrarTrazabilidadProduccion(data) {
  const fecha = data.fecha || hoy();

  // 1) cabecera del turno: puestos de cada máquina + observaciones generales
  // + el flag de Finalizado. Upsert por Fecha (antes era un append puro, que
  // duplicaba la cabecera del turno cada vez que se volvía a guardar).
  const sheetTurno = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('TrazabilidadTurno');
  const headersTurno = asegurarColumna(sheetTurno, 'Finalizado');
  const m1 = data.maquina1 || {};
  const m2 = data.maquina2 || {};
  const filaTurno = new Array(headersTurno.length).fill('');
  setPorHeader(filaTurno, headersTurno, 'Fecha', fecha);
  setPorHeader(filaTurno, headersTurno, 'Maquina1_Entrada', m1.entrada || '');
  setPorHeader(filaTurno, headersTurno, 'Maquina1_Relleno', m1.relleno || '');
  setPorHeader(filaTurno, headersTurno, 'Maquina1_Salida', m1.salida || '');
  setPorHeader(filaTurno, headersTurno, 'Maquina2_Entrada', m2.entrada || '');
  setPorHeader(filaTurno, headersTurno, 'Maquina2_Relleno', m2.relleno || '');
  setPorHeader(filaTurno, headersTurno, 'Maquina2_Salida', m2.salida || '');
  setPorHeader(filaTurno, headersTurno, 'Observaciones', data.observaciones || '');
  // "Guardado provisorio" guarda todo igual pero SIN cerrar el turno
  setPorHeader(filaTurno, headersTurno, 'Finalizado', data.provisorio ? '' : 'TRUE');
  upsertFila(sheetTurno, headersTurno, { Fecha: fecha }, filaTurno);

  // 2) un renglón por cada ítem (sabor, canasta completa, rollo o molde de
  // canasta) que todavía no se había guardado individualmente
  const sheetDet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('TrazabilidadProduccion');
  const headersDet = headersDe(sheetDet);
  // lo que estaba guardado y se dejó vacío se borra
  borrarFilasPorClaves(sheetDet, headersDet, (data.borrar || []).map(sab => ({ Fecha: fecha, Sabor: sab })));
  upsertVarias(sheetDet, headersDet, (data.items || []).map(it => ({
    claves: { Fecha: fecha, Sabor: it.sabor },
    fila: filaTrazabilidadItem(fecha, it, headersDet)
  })));
  const filas = data.items || [];
  const totalDia = leerTabla(sheetDet).values.slice(1)
    .filter(row => normalizarFecha(row[headersDet.indexOf('Fecha')]) === normalizarFecha(fecha)).length;
  let cierre = null;
  if (!data.provisorio) cierre = registrarCierre(fecha, 'Produccion', 'Turno', data.responsable || '', totalDia);

  return { ok: true, turno_guardado: true, filas_detalle: filas.length, total_dia: totalDia, finalizado: !data.provisorio, cierre };
}

// "Reabrir" el turno ya cerrado: solo saca el flag Finalizado (no toca
// puestos/observaciones/ítems ya guardados) — la web vuelve a habilitar todo
// para corregir algo puntual.
function reabrirTurnoProduccion(data) {
  const fecha = data.fecha || hoy();
  exigirUltimoCierre(fecha, 'Produccion', 'Turno');
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('TrazabilidadTurno');
  const headers = asegurarColumna(sheet, 'Finalizado');
  const existente = buscarFila(sheet, headers, { Fecha: fecha });
  if (existente) {
    const colFinalizado = headers.indexOf('Finalizado');
    sheet.getRange(existente.rowIndex + 1, colFinalizado + 1).setValue('');
  }
  reabrirCierre(fecha, 'Produccion', 'Turno');
  return { ok: true, fecha, finalizado: false };
}

// TODO lo ya guardado hoy para "Registrar producción" → Producción: si el
// turno está Finalizado, y los puestos/observaciones/ítems guardados hasta
// ahora — para repintar la pantalla con lo que ya se cargó (y bloqueada, si
// corresponde) en vez de arrancar en blanco cada vez que se entra o recarga.
function obtenerRegistroProduccionDia(fechaParam) {
  const fecha = fechaParam || hoy();
  const sheetTurno = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('TrazabilidadTurno');
  let turno = null;
  if (sheetTurno) {
    const headersTurno = asegurarColumna(sheetTurno, 'Finalizado');
    const filasTurno = leerHoja('TrazabilidadTurno').filter(f => normalizarFecha(f.Fecha) === normalizarFecha(fecha));
    // por si quedó algún duplicado de antes de que esto fuera upsert, se toma el último
    turno = filasTurno.length ? filasTurno[filasTurno.length - 1] : null;
  }
  const filasItems = leerHojaParaFecha('TrazabilidadProduccion', 'Fecha', fecha).filter(f => normalizarFecha(f.Fecha) === normalizarFecha(fecha));
  return {
    fecha,
    cierre: obtenerCierre(fecha, 'Produccion', 'Turno'),
    finalizado: !!(turno && String(turno.Finalizado).toUpperCase() === 'TRUE'),
    maquina1: turno ? { entrada: valorCelda(turno.Maquina1_Entrada), relleno: valorCelda(turno.Maquina1_Relleno), salida: valorCelda(turno.Maquina1_Salida) } : null,
    maquina2: turno ? { entrada: valorCelda(turno.Maquina2_Entrada), relleno: valorCelda(turno.Maquina2_Relleno), salida: valorCelda(turno.Maquina2_Salida) } : null,
    observaciones: turno ? valorCelda(turno.Observaciones) : '',
    items: filasItems.map(f => ({
      sabor: f.Sabor,
      maquinaNumero: valorCelda(f.MaquinaNumero),
      responsable: valorCelda(f.Responsable),
      maquinaVelocidad: valorCelda(f.MaquinaVelocidad),
      discosLote: valorCelda(f.DiscosLote),
      pesoPromTandaDiscos: valorCelda(f.PesoPromTandaDiscos),
      rellenoFecha: valorCelda(f.RellenoFecha),
      pesoInicialRelleno: valorCelda(f.PesoInicialRelleno),
      pesoFinalRelleno: valorCelda(f.PesoFinalRelleno),
      horaInicio: valorCelda(f.HoraInicio),
      horaFin: valorCelda(f.HoraFin),
      totalProduccion: valorCelda(f.TotalProduccion),
      discosDanados: valorCelda(f.DiscosDanados)
    }))
  };
}

// ---------------------------------------------------------------------------
// TRAZABILIDAD — SECTOR DISCOS. Registro simple: un renglón por día por cada
// tipo de disco (Horno/Frito/Recorte — los mismos 3 tipos que ya se usan en
// "Cargar stock" para Fábrica - Discos), con quién lo hizo y cuánto se hizo.
// Hoja "TrazabilidadDiscos" (Fecha | Tipo | Responsable | Cantidad),
// auto-creada la primera vez, igual que Ref_PorcentajeCocina. Confirmado con
// Carolina (26/09/2026).
// ---------------------------------------------------------------------------
function obtenerRegistroDiscosDia(fechaParam) {
  const fecha = fechaParam || hoy();
  const filas = leerHojaOpcional('TrazabilidadDiscos').filter(f => normalizarFecha(f.Fecha) === normalizarFecha(fecha));
  return {
    fecha,
    cierre: obtenerCierre(fecha, 'Discos', 'Discos'),
    items: filas.map(f => ({ tipo: f.Tipo, responsable: valorCelda(f.Responsable), cantidad: valorCelda(f.Cantidad) }))
  };
}

// Guardado provisorio / "Guardar y enviar" de Discos: guarda de una vez los
// tipos que quedaron sin guardar con su botón. data = { fecha, enviar,
// responsable, items: [{ tipo, responsable, cantidad }] }
function registrarTrazabilidadDiscosLote(data) {
  const fecha = data.fecha || hoy();
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('TrazabilidadDiscos');
  if (hoja && (data.borrar || []).length) {
    borrarFilasPorClaves(hoja, headersDe(hoja), data.borrar.map(t => ({ Fecha: fecha, Tipo: t })));
  }
  (data.items || []).forEach(it => {
    registrarTrazabilidadDiscosItem({ fecha, tipo: it.tipo, responsable: it.responsable, cantidad: it.cantidad });
  });
  const totalDia = leerHojaOpcional('TrazabilidadDiscos').filter(f => normalizarFecha(f.Fecha) === normalizarFecha(fecha)).length;
  let cierre = null;
  if (data.enviar) cierre = registrarCierre(fecha, 'Discos', 'Discos', data.responsable || '', totalDia);
  return { ok: true, registros_guardados: (data.items || []).length, total_dia: totalDia, cierre };
}

function registrarTrazabilidadDiscosItem(data) {
  const fecha = data.fecha || hoy();
  const tipo = data.tipo || '';
  if (!tipo) throw new Error('Falta el tipo de disco.');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('TrazabilidadDiscos');
  if (!sheet) {
    sheet = ss.insertSheet('TrazabilidadDiscos');
    sheet.appendRow(['Fecha', 'Tipo', 'Responsable', 'Cantidad']);
    sheet.getRange('A:A').setNumberFormat('@');
  }
  const headers = headersDe(sheet);
  const fila = new Array(headers.length).fill('');
  setPorHeader(fila, headers, 'Fecha', fecha);
  setPorHeader(fila, headers, 'Tipo', tipo);
  setPorHeader(fila, headers, 'Responsable', data.responsable || '');
  setPorHeader(fila, headers, 'Cantidad', Number(data.cantidad) || '');
  const r = upsertFila(sheet, headers, { Fecha: fecha, Tipo: tipo }, fila);
  return { ok: true, actualizado: r.actualizado };
}

/**
 * Registra el bruto y rinde REAL de un ingrediente de un relleno, para un
 * turno de Cocina. Si nunca se guarda nada para un ingrediente puntual, se
 * entiende que se usó el valor de referencia de la ficha técnica (Cantidad /
 * Rinde de Ref_RecetaDetalle) — no hace falta cargar todo, solo lo que
 * realmente difirió.
 * data = { fecha, relleno, ingrediente, cantidadBrutoReal, rindeReal }
 */
function registrarTrazabilidadCocinaItem(data) {
  const fecha = data.fecha || hoy();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('TrazabilidadCocina');
  if (!sheet) throw new Error('Falta la hoja TrazabilidadCocina en la planilla — creala primero (ver INSTRUCCIONES.md).');
  const headers = headersDe(sheet);
  const fila = new Array(headers.length).fill('');
  setPorHeader(fila, headers, 'Fecha', fecha);
  setPorHeader(fila, headers, 'Relleno', data.relleno || '');
  setPorHeader(fila, headers, 'Ingrediente', data.ingrediente || '');
  setPorHeader(fila, headers, 'CantidadBrutoReal', Number(data.cantidadBrutoReal) || '');
  setPorHeader(fila, headers, 'RindeReal', Number(data.rindeReal) || '');
  // upsert por Fecha+Relleno+Ingrediente — tocar "Editar" y volver a guardar
  // pisa esa misma fila en vez de duplicarla.
  const r = upsertFila(sheet, headers, { Fecha: fecha, Relleno: data.relleno || '', Ingrediente: data.ingrediente || '' }, fila);
  return { ok: true, actualizado: r.actualizado };
}

// Guardado provisorio de Cocina: guarda de una vez todos los insumos que
// quedaron sin guardar con su botón (de cualquier receta no enviada).
// data = { fecha, items: [{ relleno, ingrediente, cantidadBrutoReal, rindeReal }] }
// data = { fecha, receta, items: [{ ingrediente, cantidadBrutoReal, rindeReal }],
//          borrar: [ingrediente, ...], total: { cantidad, unidad } }
function registrarTrazabilidadCocinaLote(data) {
  const fecha = data.fecha || hoy();
  guardarRecetaCocinaDelDia(fecha, data);
  return { ok: true, registros_guardados: (data.items || []).length };
}

// insumos + borrados + total elaborado de UNA receta (provisorio o final)
function guardarRecetaCocinaDelDia(fecha, data) {
  const receta = data.receta || '';
  const items = (data.items || []).map(it => Object.assign({}, it, { relleno: it.relleno || receta }));
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('TrazabilidadCocina');
  if (sheet && (data.borrar || []).length) {
    const headers = headersDe(sheet);
    borrarFilasPorClaves(sheet, headers, data.borrar.map(ing => ({ Fecha: fecha, Relleno: receta, Ingrediente: ing })));
  }
  guardarInsumosCocina(fecha, items);
  if (data.total) guardarTotalReceta(fecha, receta, data.total);
}

// TOTAL elaborado de una receta en el día (kilos de relleno que salieron, o
// unidades para dips/postres). Hoja "TrazabilidadCocinaTotal" (se crea sola).
// Cantidad vacía = se borra. Pedido por Carolina (29/09/2026).
function guardarTotalReceta(fecha, receta, total) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('TrazabilidadCocinaTotal');
  if (!sheet) {
    sheet = ss.insertSheet('TrazabilidadCocinaTotal');
    sheet.appendRow(['Fecha', 'Receta', 'Cantidad', 'Unidad']);
    sheet.getRange('A:A').setNumberFormat('@');
  }
  const headers = headersDe(sheet);
  const cantidad = Number(total.cantidad);
  if (!(cantidad > 0)) {
    borrarFilasPorClaves(sheet, headers, [{ Fecha: fecha, Receta: receta }]);
    return;
  }
  const fila = new Array(headers.length).fill('');
  setPorHeader(fila, headers, 'Fecha', fecha);
  setPorHeader(fila, headers, 'Receta', receta);
  setPorHeader(fila, headers, 'Cantidad', cantidad);
  setPorHeader(fila, headers, 'Unidad', total.unidad || '');
  upsertFila(sheet, headers, { Fecha: fecha, Receta: receta }, fila);
}

// guarda varios insumos de Cocina de una vez (upsert por Fecha+Relleno+Ingrediente)
function guardarInsumosCocina(fecha, items) {
  if (!items.length) return;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('TrazabilidadCocina');
  if (!sheet) throw new Error('Falta la hoja TrazabilidadCocina en la planilla — creala primero (ver INSTRUCCIONES.md).');
  const headers = headersDe(sheet);
  upsertVarias(sheet, headers, items.map(it => {
    const fila = new Array(headers.length).fill('');
    setPorHeader(fila, headers, 'Fecha', fecha);
    setPorHeader(fila, headers, 'Relleno', it.relleno || '');
    setPorHeader(fila, headers, 'Ingrediente', it.ingrediente || '');
    setPorHeader(fila, headers, 'CantidadBrutoReal', Number(it.cantidadBrutoReal) || '');
    setPorHeader(fila, headers, 'RindeReal', Number(it.rindeReal) || '');
    return { claves: { Fecha: fecha, Relleno: it.relleno || '', Ingrediente: it.ingrediente || '' }, fila };
  }));
}

// TODOS los ingredientes ya guardados hoy (de cualquier receta) en
// TrazabilidadCocina — "Registrar producción → Cocina" lo usa para
// repintar los inputs con lo que ya se cargó, en vez de arrancar en blanco
// cada vez que se entra o recarga la pantalla.
function listarTrazabilidadCocinaDia(fechaParam) {
  const fecha = fechaParam || hoy();
  const filas = leerHojaParaFecha('TrazabilidadCocina', 'Fecha', fecha).filter(t => normalizarFecha(t.Fecha) === normalizarFecha(fecha));
  const totales = leerHojaOpcional('TrazabilidadCocinaTotal').filter(t => normalizarFecha(t.Fecha) === normalizarFecha(fecha));
  return {
    fecha,
    items: filas.map(f => ({
      relleno: f.Relleno,
      ingrediente: f.Ingrediente,
      cantidadBrutoReal: f.CantidadBrutoReal,
      rindeReal: f.RindeReal
    })),
    totales: totales.map(t => ({ receta: t.Receta, cantidad: valorCelda(t.Cantidad), unidad: valorCelda(t.Unidad) }))
  };
}

// ---------------------------------------------------------------------------
// "Enviar final" por receta (Relleno/Preparado/Dip/Postre), por día (hoja
// "Ref_RecetaFinalizada": Fecha | Receta — la sola presencia de la fila ES
// el flag). Mientras una receta no esté finalizada, su tabla de insumos en
// "Registrar producción → Cocina" se puede seguir editando libremente; al
// finalizarla queda BLOQUEADA entera (ver bloqueRegistroReceta en
// index.html) y recién ahí sus insumos entran al informe de "Totales del
// día" (calcularInsumosRealesDia) — antes de finalizar, esa receta NO debe
// contar en ningún informe, aunque tenga ingredientes guardados sueltos.
// "Reabrir" saca la fila y vuelve a habilitar la edición. Confirmado con
// Carolina (26/09/2026).
// ---------------------------------------------------------------------------
function listarRecetasFinalizadas(fechaParam) {
  const fecha = fechaParam || hoy();
  const filas = leerHojaOpcional('Ref_RecetaFinalizada').filter(f => normalizarFecha(f.Fecha) === normalizarFecha(fecha));
  return { fecha, recetas: filas.map(f => f.Receta) };
}

function finalizarRecetaCocina(data) {
  const fecha = data.fecha || hoy();
  const receta = data.receta || '';
  if (!receta) throw new Error('Falta el nombre de la receta a finalizar.');
  // "Guardar y enviar final": primero guarda insumos, borrados y total
  guardarRecetaCocinaDelDia(fecha, data);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Ref_RecetaFinalizada');
  if (!sheet) {
    sheet = ss.insertSheet('Ref_RecetaFinalizada');
    sheet.appendRow(['Fecha', 'Receta']);
    sheet.getRange('A:A').setNumberFormat('@');
  }
  const headers = headersDe(sheet);
  const fila = new Array(headers.length).fill('');
  setPorHeader(fila, headers, 'Fecha', fecha);
  setPorHeader(fila, headers, 'Receta', receta);
  upsertFila(sheet, headers, { Fecha: fecha, Receta: receta }, fila);
  const cierre = registrarCierre(fecha, 'Cocina', receta, data.responsable || '', (data.items || []).length);
  return { ok: true, fecha, receta, finalizada: true, insumos_guardados: (data.items || []).length, cierre };
}

function reabrirRecetaCocina(data) {
  const fecha = data.fecha || hoy();
  const receta = data.receta || '';
  exigirUltimoCierre(fecha, 'Cocina', receta);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Ref_RecetaFinalizada');
  if (sheet) {
    const headers = headersDe(sheet);
    const existente = buscarFila(sheet, headers, { Fecha: fecha, Receta: receta });
    if (existente) sheet.deleteRow(existente.rowIndex + 1);
  }
  reabrirCierre(fecha, 'Cocina', receta);
  return { ok: true, fecha, receta, finalizada: false };
}

// ---------------------------------------------------------------------------
// % de venta a cubrir de COCINA, guardado POR DÍA (hoja "Ref_PorcentajeCocina",
// una fila por fecha). Mientras no se guarde nada para un día, calcularTodo()
// usa 100% (sin ajustar). Una vez guardado, ese % queda fijo para ese día en
// TODAS las pantallas que calculan sobre los kilos de relleno de Cocina (Ver
// qué producir hoy Y Registrar producción → Cocina) — Carolina lo "reabre"
// desde la web para poder cambiarlo, no hace falta tocar la planilla.
// Confirmado con Carolina (26/09/2026).
// ---------------------------------------------------------------------------
function obtenerPorcentajeCocinaGuardado(fecha) {
  const filas = leerHojaOpcional('Ref_PorcentajeCocina');
  const fila = filas.find(f => normalizarFecha(f.Fecha) === normalizarFecha(fecha));
  return fila ? Number(fila.Porcentaje) : null;
}

function guardarPorcentajeCocina(data) {
  const fecha = data.fecha || hoy();
  const pct = Number(data.pct);
  if (!pct || pct <= 0) throw new Error('Porcentaje inválido.');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Ref_PorcentajeCocina');
  if (!sheet) {
    sheet = ss.insertSheet('Ref_PorcentajeCocina');
    sheet.appendRow(['Fecha', 'Porcentaje']);
    // fuerza la columna Fecha a texto plano para que Sheets no la "ayude"
    // convirtiéndola sola en un Date real (ver comentario de normalizarFecha).
    sheet.getRange('A:A').setNumberFormat('@');
  }
  const headers = headersDe(sheet);
  const fila = new Array(headers.length).fill('');
  setPorHeader(fila, headers, 'Fecha', fecha);
  setPorHeader(fila, headers, 'Porcentaje', pct);
  // upsert por Fecha — "Reabrir" y volver a guardar pisa el % de ese mismo
  // día en vez de duplicarlo.
  const r = upsertFila(sheet, headers, { Fecha: fecha }, fila);
  return { ok: true, fecha: fecha, pct: pct, actualizado: r.actualizado };
}

// ---------------------------------------------------------------------------
// FICHAS TÉCNICAS (recetas): Rellenos, Preparados, Postres, Dips, Edición
// Limitada. El .xlsx se lee y se parsea DIRECTO EN EL NAVEGADOR (con la
// misma librería XLSX que ya se usa para importar la planificación) — acá
// solo llega la receta ya armada en JSON, lista para guardar. Quedan en 2
// hojas:
//   Ref_Recetas        una fila por receta (el nombre es la SOLAPA del
//                       Excel — tiene que coincidir con el "Relleno" o
//                       "Sabor" que ya se usa en Ref_Calendario/Ref_Sabores,
//                       para poder cruzarlas)
//   Ref_RecetaDetalle  una fila por ingrediente de cada receta
// ---------------------------------------------------------------------------

function normalizarTexto(s) {
  const t = String(s == null ? '' : s).toUpperCase().normalize('NFD').trim();
  return t.replace(/[̀-ͯ]/g, '');
}

/**
 * data = { tipoFicha: 'Relleno'|'Preparado'|'Postre'|'Dip'|'EdicionLimitada',
 *          recetas: [ { nombreReceta, rindeCantidad, rindeUnidad,
 *                        rindeCantidad2, rindeUnidad2,
 *                        ingredientes: [ { clasificacion, ingrediente,
 *                        cantidad, medida, rinde } ] }, ... ] }
 * (ya parseado por el navegador — ver importarFichaTecnica() en index.html)
 * rindeCantidad2/rindeUnidad2 son el SEGUNDO rinde de la ficha cuando lo
 * tiene (ej. Dips: "3 KG" y, debajo, "75 UN") — quedan vacíos si la ficha
 * solo trae un rinde.
 */
function importarFichaTecnica(data) {
  const recetas = (data.recetas || []).map(r => ({
    nombreReceta: r.nombreReceta,
    tipoFicha: data.tipoFicha,
    parsed: {
      rindeCantidad: r.rindeCantidad, rindeUnidad: r.rindeUnidad,
      rindeCantidad2: r.rindeCantidad2 || '', rindeUnidad2: r.rindeUnidad2 || '',
      ingredientes: r.ingredientes || []
    }
  }));
  guardarRecetas(recetas);
  limpiarCacheHojas(['Ref_Recetas', 'Ref_RecetaDetalle']);
  return { ok: true, recetasImportadas: recetas.map(r => r.nombreReceta) };
}

// escribe/reemplaza en Ref_Recetas + Ref_RecetaDetalle. Si una receta con el
// mismo nombre ya existía (de una importación anterior), se borran sus filas
// viejas primero — así reimportar una ficha actualizada la reemplaza entera.
function guardarRecetas(recetas) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetCab = ss.getSheetByName('Ref_Recetas');
  const sheetDet = ss.getSheetByName('Ref_RecetaDetalle');
  if (!sheetCab || !sheetDet) {
    throw new Error('Faltan las hojas Ref_Recetas / Ref_RecetaDetalle en la planilla — crealas primero (ver INSTRUCCIONES.md).');
  }
  const headersCab = headersDe(sheetCab);
  const headersDet = headersDe(sheetDet);

  const nombresNuevos = recetas.map(r => normalizarTexto(r.nombreReceta));
  borrarFilasPorReceta(sheetCab, headersCab, nombresNuevos);
  borrarFilasPorReceta(sheetDet, headersDet, nombresNuevos);

  const fecha = hoy();
  const filasCab = recetas.map(r => {
    const fila = new Array(headersCab.length).fill('');
    setPorHeader(fila, headersCab, 'Receta', r.nombreReceta);
    setPorHeader(fila, headersCab, 'TipoFicha', r.tipoFicha);
    setPorHeader(fila, headersCab, 'RindeCantidad', r.parsed.rindeCantidad);
    setPorHeader(fila, headersCab, 'RindeUnidad', r.parsed.rindeUnidad);
    setPorHeader(fila, headersCab, 'RindeCantidad2', r.parsed.rindeCantidad2);
    setPorHeader(fila, headersCab, 'RindeUnidad2', r.parsed.rindeUnidad2);
    setPorHeader(fila, headersCab, 'FechaImportacion', fecha);
    return fila;
  });
  if (filasCab.length > 0) {
    sheetCab.getRange(sheetCab.getLastRow() + 1, 1, filasCab.length, headersCab.length).setValues(filasCab);
  }

  const filasDet = [];
  recetas.forEach(r => {
    r.parsed.ingredientes.forEach(ing => {
      const fila = new Array(headersDet.length).fill('');
      setPorHeader(fila, headersDet, 'Receta', r.nombreReceta);
      setPorHeader(fila, headersDet, 'Clasificacion', ing.clasificacion);
      setPorHeader(fila, headersDet, 'Ingrediente', ing.ingrediente);
      setPorHeader(fila, headersDet, 'Cantidad', ing.cantidad);
      setPorHeader(fila, headersDet, 'Medida', ing.medida);
      setPorHeader(fila, headersDet, 'Rinde', ing.rinde);
      filasDet.push(fila);
    });
  });
  if (filasDet.length > 0) {
    sheetDet.getRange(sheetDet.getLastRow() + 1, 1, filasDet.length, headersDet.length).setValues(filasDet);
  }
}

function borrarFilasPorReceta(sheet, headers, nombresNormalizados) {
  const colReceta = headers.indexOf('Receta');
  if (colReceta === -1) return;
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (nombresNormalizados.indexOf(normalizarTexto(values[i][colReceta])) !== -1) {
      sheet.deleteRow(i + 1);
    }
  }
}

function listarRecetas() {
  return { recetas: leerHojaOpcional('Ref_Recetas'), detalle: leerHojaOpcional('Ref_RecetaDetalle') };
}

/**
 * "Explota" las fichas técnicas contra lo que ya calcula calcularTodo() para
 * saber cuántos kilos de cada PREPARADO hace falta cocinar hoy — sumando lo
 * que consumen los Rellenos que Cocina cocina hoy, más lo que consumen los
 * Postres y los Dips que Producción arma hoy (mismo mecanismo que tu ejemplo
 * de la Canasta y el Puré, aplicado a lo que ya se calcula).
 *
 * Los Dips se cruzan usando el DOBLE rinde de su ficha (ej. "3 KG" y, debajo,
 * "75 UN"): la venta proyectada de Dips está en UNIDADES, así que se usa el
 * rinde en UN (no el rinde en KG) como base para calcular cuánto Preparado
 * hace falta — ver obtenerRindeEnUnidad() más abajo. Si a algún Dip le falta
 * ese segundo rinde en la ficha (formato viejo, un solo rinde en KG), se
 * avisa en vez de calcular con el número equivocado.
 *
 * Ojo con el alcance real de esta primera versión:
 * - Discos/Canastas (como la Canasta de pastel de papa de tu ejemplo) queda
 *   afuera por ahora: ese rubro hoy ni siquiera tiene un "a producir" diario
 *   calculado (está expresamente excluido de calcularTodo) — para
 *   incluirlo hay que decidir primero cómo se calcula ESO, y no lo quise
 *   tocar sin confirmarlo con vos.
 * No toca calcularTodo ni su fórmula — solo la lee y le suma esta capa.
 */
function calcularDemandaPreparados(fechaParam) {
  // el % de venta a cubrir de Cocina (guardado por día) ya viene aplicado
  // en base.cocina[].kilosDeRelleno (ver calcularTodo) — acá no hay que
  // volver a tocarlo.
  const base = calcularTodo(fechaParam);
  const cabecera = leerHojaOpcional('Ref_Recetas');
  const detalle = leerHojaOpcional('Ref_RecetaDetalle');

  if (cabecera.length === 0 || detalle.length === 0) {
    return { fecha: base.fecha, dia: base.dia, demandaPreparados: [], avisos: [] };
  }

  const recetaPorNombre = {};
  cabecera.forEach(r => { recetaPorNombre[normalizarTexto(r.Receta)] = r; });
  const ingredientesPorReceta = {};
  detalle.forEach(d => {
    const key = normalizarTexto(d.Receta);
    ingredientesPorReceta[key] = ingredientesPorReceta[key] || [];
    ingredientesPorReceta[key].push(d);
  });
  const nombresPreparados = cabecera.filter(r => r.TipoFicha === 'Preparado').map(r => r.Receta);

  function unidadBase(medida) {
    const m = normalizarTexto(medida);
    if (m === 'KG' || m === 'GR') return 'KG';
    if (m === 'L' || m === 'ML') return 'L';
    return 'UN';
  }
  function aUnidadBase(cantidad, medida) {
    const m = normalizarTexto(medida);
    if (m === 'GR' || m === 'ML') return cantidad / 1000;
    return cantidad;
  }
  // el "rinde" de una ficha puede venir en dos unidades a la vez (ej. Dips:
  // "3 KG" y, debajo, "75 UN") — esto devuelve el rinde EN LA UNIDAD pedida,
  // mirando los dos pares (RindeCantidad/RindeUnidad y RindeCantidad2/
  // RindeUnidad2) sin importar en cuál de los dos quedó guardado.
  function obtenerRindeEnUnidad(receta, unidadObjetivo) {
    if (normalizarTexto(receta.RindeUnidad) === unidadObjetivo) return Number(receta.RindeCantidad) || 0;
    if (normalizarTexto(receta.RindeUnidad2) === unidadObjetivo) return Number(receta.RindeCantidad2) || 0;
    return 0;
  }

  const demanda = {}; // nombre del preparado -> { cantidad, unidad }
  const avisos = [];

  function sumarDemanda(nombreRecetaPadre, cantidadAProducirHoy, unidadCantidad, avisarSiFalta) {
    const key = normalizarTexto(nombreRecetaPadre);
    const receta = recetaPorNombre[key];
    if (!receta) {
      if (avisarSiFalta) avisos.push('No encontré la ficha técnica de "' + nombreRecetaPadre + '".');
      return;
    }
    const rindeReceta = obtenerRindeEnUnidad(receta, unidadCantidad);
    if (rindeReceta <= 0) {
      avisos.push('La ficha de "' + nombreRecetaPadre + '" no tiene cargado el rinde en ' + unidadCantidad + ' — no se pudo cruzar con Preparados.');
      return;
    }
    const ingredientes = ingredientesPorReceta[key] || [];
    ingredientes.forEach(ing => {
      const esPreparado = nombresPreparados.some(p => normalizarTexto(p) === normalizarTexto(ing.Ingrediente));
      if (!esPreparado) return;
      const cantidadIngredienteBase = aUnidadBase(Number(ing.Cantidad) || 0, ing.Medida);
      const necesario = (cantidadIngredienteBase / rindeReceta) * cantidadAProducirHoy;
      if (!demanda[ing.Ingrediente]) demanda[ing.Ingrediente] = { cantidad: 0, unidad: unidadBase(ing.Medida) };
      demanda[ing.Ingrediente].cantidad += necesario;
    });
  }

  // 1) Rellenos que Cocina cocina hoy — en KG, como el rinde de esas fichas
  base.cocina.forEach(c => sumarDemanda(c.relleno, c.kilosDeRelleno, 'KG', true));

  // 2) Postres y Dips que Producción arma hoy — la venta se proyecta en UN,
  //    así que se usa el rinde en UN de la ficha (Discos/Canastas queda
  //    afuera por ahora, ver comentario arriba)
  base.produccion
    .filter(p => p.tipoCalculo === 'Simple' && p.aHacerUnidades > 0)
    .forEach(p => {
      const receta = recetaPorNombre[normalizarTexto(p.sabor)];
      if (receta && (receta.TipoFicha === 'Postre' || receta.TipoFicha === 'Dip')) {
        sumarDemanda(p.sabor, p.aHacerUnidades, 'UN', false);
      }
    });

  const demandaPreparados = Object.keys(demanda).map(nombre => ({
    preparado: nombre,
    cantidad: redondear(demanda[nombre].cantidad),
    unidad: demanda[nombre].unidad
  })).filter(d => d.cantidad > 0).sort((a, b) => b.cantidad - a.cantidad);

  return { fecha: base.fecha, dia: base.dia, demandaPreparados, avisos: [...new Set(avisos)] };
}

/**
 * OLLAS de Cocina: los rellenos de carne/pollo/cerdo se cocinan en lotes
 * fijos de 8 kg de carne cruda ("una olla"). Confirmado con Carolina
 * (26/09/2026), dos mecanismos distintos:
 *
 * - OLLAS_POR_PREPARADO: varios rellenos comparten un mismo Preparado (ej.
 *   "Relleno Carne" lo usan Carne Picante, Carne - Pastel de Papa y Estilo
 *   Campo). La cuenta se hace sobre el total de ESE PREPARADO — el mismo
 *   número que ya calcula calcularDemandaPreparados() —, y el gramaje de
 *   cada olla sale de escalar la FICHA DEL PREPARADO a 8 kg.
 * - OLLAS_DIRECTAS: el relleno no pasa por un Preparado — usa un ingrediente
 *   crudo directo de su propia ficha (ej. Pollo -> "Pollo Recortes", Cerdo a
 *   la Mostaza -> "Bondiola"). Cada relleno de este tipo calcula sus propias
 *   ollas por separado, a partir de su PROPIA ficha, y el gramaje de cada
 *   olla sale de escalar esa misma ficha a 8 kg de ese ingrediente.
 *
 * Hamburguesa no entra en ninguno de los dos (no se hace en olla).
 */
const KG_POR_OLLA = 8;
const OLLAS_POR_PREPARADO = {
  'Relleno Carne': ['Carne Picante', 'Carne - Pastel de Papa', 'Estilo Campo'],
  'Pollo Grille': ['Pollo y Cheddar']
};
// la carne CRUDA de cada Preparado en olla: las ollas se cuentan sobre ESTE
// ingrediente (1 olla = 8 kg crudos), no sobre el preparado terminado — antes
// se dividía el preparado terminado por 8 y daba de más (ej. 25 kg de
// Relleno Carne = 16 kg de carne picada = 2 ollas, no 4). Corregido 29/09/2026.
const CARNE_CRUDA_PREPARADO = {
  'Relleno Carne': 'Carne Picada',
  'Pollo Grille': 'Pollo Recortes'
};
// pasa una cantidad de ficha a KG (las fichas cargan la carne en KG, pero por
// las dudas se contemplan GR)
function aKilos(cantidad, medida) {
  const m = normalizarTexto(medida);
  return m === normalizarTexto('GR') || m === normalizarTexto('G') ? (Number(cantidad) || 0) / 1000 : (Number(cantidad) || 0);
}
const OLLAS_DIRECTAS = {
  'Pollo': 'Pollo Recortes',
  'Suprema Pastora': 'Pollo Recortes',
  'Cerdo a la Mostaza': 'Bondiola',
  'Cerdo a la Barbacoa': 'Bondiola',
  'Carne Cuchillo - Carne y Queso': 'Cuadrada'
};

function calcularOllas(fechaParam) {
  // el % de venta a cubrir de Cocina (guardado por día) ya viene aplicado en
  // base.cocina[].kilosDeRelleno y en demandaPrep (ver calcularTodo /
  // calcularDemandaPreparados) — acá no hay que volver a tocarlo.
  const base = calcularTodo(fechaParam);
  const demandaPrep = calcularDemandaPreparados(fechaParam);
  const cabecera = leerHojaOpcional('Ref_Recetas');
  const detalle = leerHojaOpcional('Ref_RecetaDetalle');

  const recetaPorNombre = {};
  cabecera.forEach(r => { recetaPorNombre[normalizarTexto(r.Receta)] = r; });
  const ingredientesPorReceta = {};
  detalle.forEach(d => {
    const key = normalizarTexto(d.Receta);
    ingredientesPorReceta[key] = ingredientesPorReceta[key] || [];
    ingredientesPorReceta[key].push(d);
  });

  function gramajeEscalado(nombreFicha, factor) {
    const key = normalizarTexto(nombreFicha);
    return (ingredientesPorReceta[key] || []).map(ing => ({
      ingrediente: ing.Ingrediente,
      cantidad: redondear((Number(ing.Cantidad) || 0) * factor),
      medida: ing.Medida
    }));
  }

  const preparados = [];
  Object.keys(OLLAS_POR_PREPARADO).forEach(nombrePrep => {
    const dem = demandaPrep.demandaPreparados.find(d => normalizarTexto(d.preparado) === normalizarTexto(nombrePrep));
    if (!dem || dem.cantidad <= 0) return;
    const receta = recetaPorNombre[normalizarTexto(nombrePrep)];
    if (!receta || !Number(receta.RindeCantidad)) return; // sin ficha del Preparado, no se puede escalar
    const ingredienteClave = CARNE_CRUDA_PREPARADO[nombrePrep];
    const ingClave = (ingredientesPorReceta[normalizarTexto(nombrePrep)] || [])
      .find(i => normalizarTexto(i.Ingrediente) === normalizarTexto(ingredienteClave));
    const crudoPorBatch = ingClave ? aKilos(ingClave.Cantidad, ingClave.Medida) : 0;
    if (!crudoPorBatch) return; // la ficha no tiene cargada la carne cruda
    const kilosCrudos = dem.cantidad * crudoPorBatch / Number(receta.RindeCantidad);
    preparados.push({
      nombre: nombrePrep,
      kilos: dem.cantidad,
      ingredienteClave,
      kilosNecesarios: redondear(kilosCrudos),
      ollas: Math.ceil(kilosCrudos / KG_POR_OLLA),
      usan: OLLAS_POR_PREPARADO[nombrePrep],
      gramajePorOlla: gramajeEscalado(nombrePrep, KG_POR_OLLA / crudoPorBatch)
    });
  });

  const rellenos = [];
  Object.keys(OLLAS_DIRECTAS).forEach(nombreRelleno => {
    const c = base.cocina.find(x => normalizarTexto(x.relleno) === normalizarTexto(nombreRelleno));
    if (!c || !(c.kilosDeRelleno > 0)) return;
    const receta = recetaPorNombre[normalizarTexto(nombreRelleno)];
    if (!receta || !Number(receta.RindeCantidad)) return; // sin ficha del relleno, no se puede escalar
    const ingredienteClave = OLLAS_DIRECTAS[nombreRelleno];
    const ingredientes = ingredientesPorReceta[normalizarTexto(nombreRelleno)] || [];
    const ingClave = ingredientes.find(i => normalizarTexto(i.Ingrediente) === normalizarTexto(ingredienteClave));
    const crudoPorBatch = ingClave ? aKilos(ingClave.Cantidad, ingClave.Medida) : 0;
    if (!crudoPorBatch) return; // la ficha no tiene cargado ese ingrediente
    const cantidadClaveHoy = c.kilosDeRelleno * (crudoPorBatch / Number(receta.RindeCantidad));
    const ollas = Math.ceil(cantidadClaveHoy / KG_POR_OLLA);
    if (ollas <= 0) return;
    const factor = KG_POR_OLLA / crudoPorBatch;
    rellenos.push({
      nombre: nombreRelleno,
      ingredienteClave,
      kilosNecesarios: redondear(cantidadClaveHoy),
      ollas,
      gramajePorOlla: gramajeEscalado(nombreRelleno, factor)
    });
  });

  return { fecha: base.fecha, dia: base.dia, preparados, rellenos };
}

/**
 * TOTAL de insumos REALES usados hoy en Cocina, sumado por ingrediente en
 * unidad base (KG/L/UN) — cruza TODOS los Preparados, Rellenos, Dips y
 * Postres que se cocinan hoy. Para cada insumo de cada ficha usa el bruto
 * real cargado en TrazabilidadCocina si existe; si no se cargó nada para
 * ese insumo puntual, asume el valor de la ficha ya escalado al total de
 * hoy (misma convención que "Registrar producción" → Cocina: "si no
 * cargás nada, se toma el valor de la ficha"). Confirmado con Carolina
 * (26/09/2026).
 */
function calcularInsumosRealesDia(fechaParam) {
  const base = calcularTodo(fechaParam);
  const demandaPrep = calcularDemandaPreparados(fechaParam);
  const cabecera = leerHojaOpcional('Ref_Recetas');
  const detalle = leerHojaOpcional('Ref_RecetaDetalle');
  const traza = leerHojaParaFecha('TrazabilidadCocina', 'Fecha', base.fecha).filter(t => normalizarFecha(t.Fecha) === normalizarFecha(base.fecha));
  // solo entran al informe las recetas que YA se "enviaron final" hoy desde
  // "Registrar producción" → Cocina — mientras no se finalice una receta, no
  // tiene que sumar nada acá, ni siquiera con el valor de ficha. Confirmado
  // con Carolina (26/09/2026): "las recetas debería tener un enviar final y
  // ahí recién contabilizar".
  const finalizadas = new Set(
    leerHojaOpcional('Ref_RecetaFinalizada')
      .filter(f => normalizarFecha(f.Fecha) === normalizarFecha(base.fecha))
      .map(f => normalizarTexto(f.Receta))
  );

  const recetaPorNombre = {};
  cabecera.forEach(r => { recetaPorNombre[normalizarTexto(r.Receta)] = r; });
  const ingredientesPorReceta = {};
  detalle.forEach(d => {
    const key = normalizarTexto(d.Receta);
    ingredientesPorReceta[key] = ingredientesPorReceta[key] || [];
    ingredientesPorReceta[key].push(d);
  });
  const realGuardado = {}; // "receta|ingrediente" -> CantidadBrutoReal (en la Medida de esa ficha)
  traza.forEach(t => {
    if (t.CantidadBrutoReal === '' || t.CantidadBrutoReal == null) return;
    realGuardado[normalizarTexto(t.Relleno) + '|' + normalizarTexto(t.Ingrediente)] = Number(t.CantidadBrutoReal) || 0;
  });

  function unidadBase(medida) {
    const m = normalizarTexto(medida);
    if (m === 'KG' || m === 'GR') return 'KG';
    if (m === 'L' || m === 'ML') return 'L';
    return 'UN';
  }
  function aUnidadBase(cantidad, medida) {
    const m = normalizarTexto(medida);
    if (m === 'GR' || m === 'ML') return cantidad / 1000;
    return cantidad;
  }
  function obtenerRindeEnUnidad(receta, unidadObjetivo) {
    if (normalizarTexto(receta.RindeUnidad) === unidadObjetivo) return Number(receta.RindeCantidad) || 0;
    if (normalizarTexto(receta.RindeUnidad2) === unidadObjetivo) return Number(receta.RindeCantidad2) || 0;
    return 0;
  }

  const totales = {}; // ingrediente -> { cantidad (en unidad base), unidad }
  const acumuladas = new Set();
  function acumular(nombreReceta, factor) {
    const key = normalizarTexto(nombreReceta);
    if (acumuladas.has(key)) return;
    acumuladas.add(key);
    (ingredientesPorReceta[key] || []).forEach(ing => {
      const guardado = realGuardado[key + '|' + normalizarTexto(ing.Ingrediente)];
      const cantidadNativa = guardado != null ? guardado : (Number(ing.Cantidad) || 0) * factor;
      if (!totales[ing.Ingrediente]) totales[ing.Ingrediente] = { cantidad: 0, unidad: unidadBase(ing.Medida) };
      totales[ing.Ingrediente].cantidad += aUnidadBase(cantidadNativa, ing.Medida);
    });
  }

  // 1) Preparados (Relleno Carne, Pollo Grille, y cualquier otro que haya) —
  // solo si YA se envió final ese Preparado
  demandaPrep.demandaPreparados.forEach(d => {
    if (!finalizadas.has(normalizarTexto(d.preparado))) return;
    const receta = recetaPorNombre[normalizarTexto(d.preparado)];
    if (!receta || !Number(receta.RindeCantidad)) return;
    acumular(d.preparado, d.cantidad / Number(receta.RindeCantidad));
  });

  // 2) Rellenos de hoy — solo si YA se envió final ese Relleno
  base.cocina.filter(c => c.kilosDeRelleno > 0).forEach(c => {
    if (!finalizadas.has(normalizarTexto(c.relleno))) return;
    const receta = recetaPorNombre[normalizarTexto(c.relleno)];
    if (!receta || !Number(receta.RindeCantidad)) return;
    acumular(c.relleno, c.kilosDeRelleno / Number(receta.RindeCantidad));
  });

  // 3) Dips y Postres de hoy — solo si YA se envió final ese Dip/Postre
  base.produccion
    .filter(p => p.tipoCalculo === 'Simple' && p.aHacerUnidades > 0)
    .forEach(p => {
      if (!finalizadas.has(normalizarTexto(p.sabor))) return;
      const receta = recetaPorNombre[normalizarTexto(p.sabor)];
      if (!receta || (receta.TipoFicha !== 'Postre' && receta.TipoFicha !== 'Dip')) return;
      const rinde = obtenerRindeEnUnidad(receta, 'UN');
      if (!rinde) return;
      acumular(p.sabor, p.aHacerUnidades / rinde);
    });

  // 4) Elaboración ADICIONAL (recetas enviadas que el cálculo del día no
  //    pedía): se escalan por el "Total elaborado" cargado (o 1 receta de ficha)
  const totalElaborado = {};
  leerHojaOpcional('TrazabilidadCocinaTotal')
    .filter(t => normalizarFecha(t.Fecha) === normalizarFecha(base.fecha))
    .forEach(t => { totalElaborado[normalizarTexto(t.Receta)] = Number(t.Cantidad) || 0; });
  finalizadas.forEach(key => {
    if (acumuladas.has(key)) return;
    const receta = recetaPorNombre[key];
    if (!receta) return;
    const rinde = Number(receta.RindeCantidad) || 0;
    const total = totalElaborado[key];
    acumular(receta.Receta, total && rinde ? total / rinde : 1);
  });

  const totalesPorIngrediente = Object.keys(totales)
    .map(nombre => ({ ingrediente: nombre, cantidad: redondear(totales[nombre].cantidad), unidad: totales[nombre].unidad }))
    .filter(t => t.cantidad > 0)
    .sort((a, b) => b.cantidad - a.cantidad);

  return { fecha: base.fecha, dia: base.dia, totalesPorIngrediente, recetasFinalizadas: Array.from(finalizadas) };
}

// como leerHoja(), pero devuelve [] si la hoja todavía no existe (para no
// romper pantallas que dependen de esto antes de que se creen las hojas).
function leerHojaOpcional(nombre) {
  if (HOJAS_CACHEADAS.indexOf(nombre) !== -1) {
    const enCache = leerDeCache(nombre);
    if (enCache) return enCache;
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nombre);
  if (!sheet) return [];
  return leerHoja(nombre);
}

// ---------------------------------------------------------------------------
// Utilidades de fecha
// ---------------------------------------------------------------------------

function hoy() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

// Google Sheets auto-detecta como FECHA cualquier celda a la que se le
// escriba un string tipo "2026-09-26" (pasa igual escribiéndolo a mano
// desde la UI o con setValues() desde Apps Script) — así que una columna
// "Fecha" recién creada por código (sin el formato forzado a texto) puede
// terminar guardando un objeto Date real en vez del string. Esto rompía la
// comparación de "¿esta fila es de hoy?" en todos lados que hacían
// String(fila.Fecha) === String(fecha): un Date se convierte a un string
// larguísimo tipo "Sat Sep 26 2026 00:00:00 GMT-0300 (...)", que nunca es
// igual a "2026-09-26" — el síntoma que reportó Carolina era justamente el
// % de Cocina "guardando" pero volviendo a 100 al recargar. Esta función
// normaliza CUALQUIER valor de una celda de fecha (Date o string) al mismo
// formato 'yyyy-MM-dd', para comparar siempre manzanas con manzanas.
// Confirmado con Carolina (26/09/2026).
function normalizarFecha(valor) {
  if (valor instanceof Date) return Utilities.formatDate(valor, TZ, 'yyyy-MM-dd');
  return String(valor == null ? '' : valor);
}

function diaSemana(fechaStr) {
  const d = new Date(fechaStr + 'T00:00:00');
  const idx = (d.getDay() + 6) % 7; // JS: 0=domingo -> acá 0=lunes
  return DIAS[idx];
}

function sumarDias(fechaStr, n) {
  const d = new Date(fechaStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

// ---------------------------------------------------------------------------
// Leer una hoja como lista de objetos (fila 1 = encabezados)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// VELOCIDAD: las hojas que crecen todos los días (Stock, Envios, Trazabilidad)
// se leen solo en sus ÚLTIMAS filas — lo del día y las semanas anteriores —
// en vez de la hoja entera. Así la app no se va poniendo más lenta a medida
// que se acumula historial (el historial sigue completo en la planilla; los
// informes que piden una fecha vieja leen la hoja entera). 30/09/2026.
// ---------------------------------------------------------------------------
const FILAS_RECIENTES = { Stock: 4000, Envios: 4000, TrazabilidadProduccion: 3000, TrazabilidadCocina: 4000 };

// encabezados sin leer toda la hoja
function headersDe(sheet) {
  const cols = Math.max(sheet.getLastColumn(), 1);
  return sheet.getRange(1, 1, 1, cols).getValues()[0];
}

// { values (values[0] = encabezados), filaDe(i) = nº de fila real en la hoja,
//   completa: true si se leyó desde la fila 2 }
function leerTabla(sheet, forzarCompleta) {
  const recientes = FILAS_RECIENTES[sheet.getName()];
  const ultima = sheet.getLastRow();
  const cols = Math.max(sheet.getLastColumn(), 1);
  if (forzarCompleta || !recientes || ultima - 1 <= recientes) {
    const values = sheet.getDataRange().getValues();
    return { values, filaDe: i => i + 1, completa: true };
  }
  const desde = ultima - recientes + 1;
  const headers = sheet.getRange(1, 1, 1, cols).getValues()[0];
  const cuerpo = sheet.getRange(desde, 1, recientes, cols).getValues();
  return { values: [headers].concat(cuerpo), filaDe: i => desde + i - 1, completa: false };
}

// Escribe de UNA vez las celdas ya modificadas en tabla.values (filas
// `indices`, columnas desde colA hasta colB, 0-based) — en vez de un
// setValue por celda, que con 30 productos eran 90 llamadas lentas.
function escribirBloque(sheet, tabla, indices, colA, colB) {
  if (!indices.length) return;
  const min = Math.min.apply(null, indices), max = Math.max.apply(null, indices);
  const bloque = [];
  for (let i = min; i <= max; i++) bloque.push(tabla.values[i].slice(colA, colB + 1));
  sheet.getRange(tabla.filaDe(min), colA + 1, max - min + 1, colB - colA + 1).setValues(bloque);
}

// lista de objetos de una hoja (todas las filas, o solo las recientes si es
// una hoja que crece — ver FILAS_RECIENTES)
function leerHojaDirecto(nombre, forzarCompleta) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nombre);
  const values = leerTabla(sheet, forzarCompleta).values;
  const headers = values[0];
  return values.slice(1)
    // se ignoran filas vacías y filas que son en realidad el encabezado
    // repetido a mitad de la hoja (pasa si alguna vez se pegó la tabla dos
    // veces) — si no, ese renglón entra como un dato más y aparece como
    // ítem fantasma (ej. "Categoria" en el desplegable).
    .filter(row => row[0] !== '' && row[0] !== null && row[0] !== headers[0])
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = row[i]);
      return obj;
    });
}

// ---------------------------------------------------------------------------
// Caché de hojas de referencia (para que la app responda más rápido)
// ---------------------------------------------------------------------------
// Estas hojas cambian poco (se importan desde la app o se editan a mano en la
// planilla), pero se leen en casi todos los pedidos. Se guarda una copia por
// CACHE_SEGUNDOS y se descarta sola cuando:
//   - se importa desde la app (Venta proyectada / Fichas técnicas),
//   - alguien edita a mano una de estas hojas en la planilla (onEdit),
//   - se toca "Refrescar datos de la planilla" en la app.
// Si nada de eso pasa, igual se vuelve a leer de la planilla a los 10 minutos.
// Las hojas de carga diaria (Stock, Envios, Trazabilidad...) NO se cachean.
const HOJAS_CACHEADAS = ['Ref_Sabores', 'Ref_Calendario', 'Ref_VentaDiaria', 'Ref_Recetas', 'Ref_RecetaDetalle', 'Empleados'];
const CACHE_SEGUNDOS = 600;
const CACHE_TROZO = 90000; // CacheService acepta hasta 100 KB por valor

// para consultas de una fecha puntual: lee lo reciente y, si esa fecha es más
// vieja que lo leído, vuelve a leer la hoja entera.
function leerHojaParaFecha(nombre, columnaFecha, fecha) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nombre);
  if (!sheet) return [];
  const t = leerTabla(sheet);
  if (!t.completa) {
    const c = t.values[0].indexOf(columnaFecha);
    let minima = null;
    for (let i = 1; i < t.values.length; i++) {
      const f = normalizarFecha(t.values[i][c]);
      if (f && (!minima || f < minima)) minima = f;
    }
    if (minima && fecha < minima) return leerHojaDirecto(nombre, true);
  }
  return leerHojaDirecto(nombre);
}

function leerHoja(nombre) {
  if (HOJAS_CACHEADAS.indexOf(nombre) === -1) return leerHojaDirecto(nombre);
  const enCache = leerDeCache(nombre);
  if (enCache) return enCache;
  const filas = leerHojaDirecto(nombre);
  guardarEnCache(nombre, filas);
  return filas;
}

// Las fechas se guardan marcadas para devolverlas como Date (igual que
// getValues()), así el resto del código no nota la diferencia.
function guardarEnCache(nombre, filas) {
  try {
    const json = JSON.stringify(filas, function (k, v) {
      return (this[k] instanceof Date) ? { __fecha: this[k].getTime() } : v;
    });
    const trozos = {};
    let n = 0;
    for (let i = 0; i < json.length; i += CACHE_TROZO) {
      trozos['hoja:' + nombre + ':' + n] = json.substring(i, i + CACHE_TROZO);
      n++;
    }
    if (n > 50) return; // demasiado grande para la caché: se sigue leyendo directo
    trozos['hoja:' + nombre + ':n'] = String(n);
    CacheService.getScriptCache().putAll(trozos, CACHE_SEGUNDOS);
  } catch (err) {
    // si la caché falla, no pasa nada: se lee directo de la planilla
  }
}

function leerDeCache(nombre) {
  try {
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get('hoja:' + nombre + ':n'));
    if (!n) return null;
    const claves = [];
    for (let i = 0; i < n; i++) claves.push('hoja:' + nombre + ':' + i);
    const trozos = cache.getAll(claves);
    let json = '';
    for (let i = 0; i < n; i++) {
      if (trozos[claves[i]] == null) return null; // se venció una parte
      json += trozos[claves[i]];
    }
    return JSON.parse(json, (k, v) => (v && typeof v === 'object' && v.__fecha !== undefined) ? new Date(v.__fecha) : v);
  } catch (err) {
    return null;
  }
}

// Sin nombres = descarta todas las hojas cacheadas.
function limpiarCacheHojas(nombres) {
  const lista = nombres && nombres.length ? nombres : HOJAS_CACHEADAS;
  cambiarVersionDatos();
  try {
    CacheService.getScriptCache().removeAll(lista.map(h => 'hoja:' + h + ':n'));
  } catch (err) {}
  return { ok: true, hojas: lista };
}

// Trigger simple de Google Sheets: corre solo cada vez que alguien edita la
// planilla a mano. Si la edición fue en una hoja cacheada, se descarta su copia.
function onEdit(e) {
  try {
    const hoja = e && e.range ? e.range.getSheet().getName() : '';
    if (HOJAS_CACHEADAS.indexOf(hoja) !== -1) limpiarCacheHojas([hoja]);
    cambiarVersionDatos(); // una edición a mano también invalida los cálculos guardados
  } catch (err) {}
}

// ---------------------------------------------------------------------------
// EL MOTOR
// ---------------------------------------------------------------------------
//
// Una sola fórmula (validada en el Excel, hoja "CONTROL DIARIO (PRUEBA)"):
//
//   A hacer = MAX(venta a cubrir − stock disponible, 0)
//
// "venta a cubrir" es la suma de la venta proyectada de los días que indica
// Ref_Calendario.DiasQueCubre para ese lote. Para rellenos con reposo, esos
// días ya arrancan el día que se ARMA (no el que se cocina) — la venta del
// día de cocina no se contempla acá porque ya la cubrió la tanda anterior.
//
// "Stock disponible" excluye cualquier lote cuyo vencimiento sea ANTERIOR a
// cuando llegaría el próximo lote de ese mismo relleno (ese excedente pasa a
// la lista de "vender ya", no resta del cálculo).
//
// A partir de esta única función se arman 3 vistas:
//   COCINA:      qué relleno hay que cocinar HOY (kilos, agrupado por relleno)
//   PRODUCCIÓN:  qué empanada hay que armar HOY (unidades, por sabor) — para
//                los rellenos con reposo, esto muestra lo que se cocinó AYER
//   DISCOS:      los discos que necesita la tanda de PRODUCCIÓN de hoy

// calcularTodo() se llama varias veces dentro de un mismo pedido (Ollas →
// Demanda de preparados → calcularTodo, etc.). Se memoriza el resultado por
// fecha mientras dura ESE pedido, para no recalcular ni releer las hojas.
const MEMO_CALCULAR_TODO = {};
function calcularTodo(fechaParam) {
  const clave = fechaParam || hoy();
  if (!MEMO_CALCULAR_TODO[clave]) MEMO_CALCULAR_TODO[clave] = JSON.stringify(calcularTodoSinMemo(fechaParam));
  return JSON.parse(MEMO_CALCULAR_TODO[clave]); // copia, por si quien lo usa lo modifica
}

function calcularTodoSinMemo(fechaParam) {
  const fechaHoy = fechaParam || hoy();
  const diaHoy = diaSemana(fechaHoy);

  const refSabores = leerHoja('Ref_Sabores');
  const refCalendario = leerHoja('Ref_Calendario');
  const refVenta = ventaBase();
  const stock = stockBase(fechaHoy);

  const alertasVencimiento = [];

  // --- COCINA: rellenos cuyo DiaCocina es hoy ---
  const cocina = [];
  refSabores.filter(s => String(s.TipoCalculo).trim() === 'Calendario').forEach(s => {
    const lote = refCalendario.find(c => c.Relleno === s.Relleno && c.DiaCocina === diaHoy);
    if (!lote) return;
    const r = calcularLote(s, lote, fechaHoy, refVenta, stock, alertasVencimiento);
    cocina.push(r);
  });
  const cocinaPorRelleno = agruparPorRelleno(cocina);

  // % de venta a cubrir de Cocina, guardado para ESTE día (ver
  // guardarPorcentajeCocina). Si todavía no se guardó nada hoy, se usa 100%
  // (sin ajustar). Esto SOLO escala los kilos de relleno que cocina Cocina —
  // no toca aHacerUnidades de Producción/Envíos, que sigue siendo siempre
  // venta a cubrir − stock disponible.
  const porcentajeCocina = obtenerPorcentajeCocinaGuardado(fechaHoy);
  const factorPctCocina = (porcentajeCocina || 100) / 100;
  cocinaPorRelleno.forEach(c => {
    c.kilosDeRelleno = redondear(c.kilosDeRelleno * factorPctCocina);
    c.sabores.forEach(s => { s.kilosDeRelleno = redondear(s.kilosDeRelleno * factorPctCocina); });
  });

  // --- PRODUCCIÓN: empanadas cuyo DiaArmado es hoy (calculado desde SU día de
  //     cocina real, que es ayer si tiene reposo) + todo lo "Simple" ---
  const produccion = [];
  refSabores.filter(s => String(s.TipoCalculo).trim() === 'Calendario').forEach(s => {
    const lote = refCalendario.find(c => c.Relleno === s.Relleno && c.DiaArmado === diaHoy);
    if (!lote) return;
    const reposo = String(s.Reposo).trim() === 'Sí';
    const fechaCocinaDeEsteLote = reposo ? sumarDias(fechaHoy, -1) : fechaHoy;
    const r = calcularLote(s, lote, fechaCocinaDeEsteLote, refVenta, stock, alertasVencimiento);
    produccion.push(r);
  });
  refSabores.filter(s => String(s.TipoCalculo).trim() !== 'Calendario').forEach(s => {
    if (RUBROS_VISIBLES.indexOf(rubroDeSabor(s)) === -1) return;
    produccion.push(calcularItemSimple(s, diaHoy, fechaHoy, refVenta, stock, alertasVencimiento));
  });

  // --- DISCOS: derivado de PRODUCCIÓN (solo empanadas) ---
  const discos = { Horno: 0, HornoConRecorte: 0, Frito: 0 };
  produccion.filter(f => f.tipoCalculo === 'Calendario').forEach(f => {
    const tipo = f.tipoDisco || 'Horno';
    discos[tipo] = redondear((discos[tipo] || 0) + f.aHacerUnidades);
  });
  const discosDetalle = {
    horno: { unidades: discos.Horno, docenas: redondear(discos.Horno / 12) },
    hornoConRecorte: { unidades: discos.HornoConRecorte, docenas: redondear(discos.HornoConRecorte / 12) },
    frito: { unidades: discos.Frito, docenas: redondear(discos.Frito / 12) },
    totalHornoDocenas: redondear((discos.Horno + discos.HornoConRecorte) / 12)
  };

  return {
    fecha: fechaHoy,
    dia: diaHoy,
    cocina: cocinaPorRelleno,
    // null = todavía no se guardó el % de este día (la web lo muestra
    // editable, con 100% de referencia); un número = ya se guardó y se usó
    // para escalar cocinaPorRelleno de arriba — la web lo muestra fijo, con
    // un botón "Reabrir" para poder cambiarlo.
    porcentajeCocina: porcentajeCocina,
    produccion: produccion,
    discos: discosDetalle,
    alertasVencimiento: dedupAlertas(alertasVencimiento)
  };
}

/**
 * Lo que hay que dejar armado HOY para que Producción pueda armar MAÑANA:
 * - Rollos de Jamón y Queso: se arman el día antes de hornear/freír esas
 *   empanadas — mismo mecanismo de Ref_Calendario que cualquier otro
 *   relleno (el reposo ya hace que DiaCocina quede 1 día antes de
 *   DiaArmado), solo que acá lo arma Producción y se cuenta en UNIDADES
 *   (rollos), no en kilos — por eso se usa aHacerUnidades de MAÑANA en vez
 *   de kilosDeRelleno de Cocina.
 * - Canastas (el molde armado con el disco, todavía sin rellenar): las que
 *   se van a usar mañana tienen que quedar armadas hoy. A diferencia del
 *   relleno, esto no tiene su propia fila en Ref_Calendario (comparten
 *   DiaArmado con su empanada hermana del mismo relleno), así que se
 *   calcula mirando directamente la producción de MAÑANA por sabor.
 * No modifica calcularTodo ni su fórmula — solo lo llama para mañana y
 * reordena el resultado.
 */
function calcularPrepDiaAnterior(fechaParam) {
  const fechaHoy = fechaParam || hoy();
  const fechaManana = sumarDias(fechaHoy, 1);
  const manana = calcularTodo(fechaManana);

  // Mismo % de venta a cubrir que está usando Cocina HOY (el día en que
  // efectivamente se arman estos extras) — misma razón que en Cocina: el
  // local ya va a contar con algo de stock, así que no hace falta dejar
  // armado el 100% de lo que da el cálculo de mañana. Se usa el % de HOY
  // (no el de mañana) porque este trabajo se hace hoy, y el de mañana
  // normalmente todavía no está guardado. Si todavía no se guardó nada hoy,
  // se usa 100% (sin ajustar), igual que en Cocina. Confirmado con Carolina
  // (26/09/2026).
  const porcentajeCocinaHoy = obtenerPorcentajeCocinaGuardado(fechaHoy);
  const factorPctCocina = (porcentajeCocinaHoy || 100) / 100;

  const rollosJyQ = manana.produccion
    .filter(p => p.tipoCalculo === 'Calendario' && normalizarTexto(p.relleno) === normalizarTexto('Jamón y Queso'))
    .reduce((acc, p) => acc + (Number(p.aHacerUnidades) || 0), 0);

  const canastas = manana.produccion
    .filter(p => p.tipoCalculo === 'Calendario' && p.categoria === 'Canasta')
    .map(p => ({ sabor: p.sabor, aHacerUnidades: redondear((Number(p.aHacerUnidades) || 0) * factorPctCocina) }))
    .sort((a, b) => b.aHacerUnidades - a.aHacerUnidades);

  return {
    fecha: fechaHoy,
    fechaManana: fechaManana,
    diaManana: manana.dia,
    porcentajeCocina: porcentajeCocinaHoy,
    rollosJyQ: redondear(rollosJyQ * factorPctCocina),
    canastas: canastas
  };
}

// ---------------------------------------------------------------------------
// ENVÍOS: cuánto hay que mandarle HOY a cada local.
//
// OJO — esto NO usa el calendario de lotes (DiaArmado/DiasQueCubre) como
// Producción. Ese calendario dice cuándo FÁBRICA arma cada tanda (agrupa
// varios días de venta en una sola tanda porque no arma todos los días).
// Pero un local necesita reponerse TODOS los días, arme o no arme fábrica
// ese día puntual — el sábado Pollo F igual se vende, aunque fábrica no arme
// pollo ese sábado (ya armó el viernes para cubrir viernes+sábado juntos).
//
// Por eso acá la cuenta es más simple y es la MISMA para todos los rubros
// (empanadas incluidas): venta proyectada de HOY en ESE local, menos el
// stock que ESE local ya tiene cargado. Un solo día, no una ventana de
// varios días — es lo que hace calcularItemSimple.
// ---------------------------------------------------------------------------
function calcularEnvios(fechaParam) {
  const fechaHoy = fechaParam || hoy();
  const diaHoy = diaSemana(fechaHoy);

  const refSabores = leerHoja('Ref_Sabores');
  const refVenta = ventaBase();
  const stock = stockBase(fechaHoy);

  const envios = {};
  LOCALES.forEach(local => {
    const alertasVencimiento = []; // no se usan acá (ya se muestran en Producción), pero stockVigente las pide
    const items = [];

    refSabores.forEach(s => {
      if (RUBROS_VISIBLES.indexOf(rubroDeSabor(s)) === -1) return;
      items.push(calcularItemSimple(s, diaHoy, fechaHoy, refVenta, stock, alertasVencimiento, local));
    });

    // se listan TODOS los productos (como en Cargar Stock), no solo los que
    // dieron orden > 0 — así Fábrica puede mandar algo aunque el cálculo dé 0.
    envios[local] = items;
  });

  return { fecha: fechaHoy, dia: diaHoy, envios };
}

// calcula UN lote (un sabor, un relleno, evaluado desde fechaCocina).
// Si se pasa `soloLocal`, la venta a cubrir y el stock disponible se filtran
// a ESE local puntual en vez de sumar los 3 locales — así se calcula cuánto
// hay que ENVIAR a ese local en particular, con la misma fórmula de siempre.
function calcularLote(s, lote, fechaCocina, refVenta, stock, alertasVencimiento, soloLocal) {
  const diasCubrir = String(lote.DiasQueCubre).split('+').map(x => x.trim()).filter(Boolean);
  const reposo = String(s.Reposo).trim() === 'Sí';

  const inicioCobertura = reposo ? sumarDias(fechaCocina, 1) : fechaCocina;
  const fechaProximoLote = sumarDias(inicioCobertura, diasCubrir.length);

  // Ref_VentaDiaria está cargada en UNIDADES directas (no docenas) — sin conversión.
  let ventaCubrir = 0;
  const ventasDeEsteSabor = refVenta.filter(v => v.Sabor === s.Sabor && (!soloLocal || v.Local === soloLocal));
  // venta de cada día cubierto, con su fecha (para saber hasta qué día
  // sirve cada lote de stock según su vencimiento)
  const ventana = diasCubrir.map((dia, i) => {
    let venta = 0;
    ventasDeEsteSabor.forEach(v => { venta += (Number(v[dia]) || 0); });
    ventaCubrir += venta;
    return { fecha: sumarDias(inicioCobertura, i), venta: venta };
  });

  const { stockValido, stockPorVencer, stockFabrica, stockLocales } = stockVigenteVentana(s.Sabor, stock, ventana, alertasVencimiento, soloLocal);

  const aHacer = Math.max(ventaCubrir - stockValido, 0);

  return {
    sabor: s.Sabor,
    categoria: s.Categoria,
    rubro: rubroDeSabor(s),
    tipoCalculo: 'Calendario',
    tipoDisco: s.TipoDisco,
    relleno: lote.Relleno,
    diaCocina: lote.DiaCocina,
    diaArmado: lote.DiaArmado,
    diasQueCubre: lote.DiasQueCubre,
    reposo: reposo,
    objetivoUnidades: redondear(ventaCubrir),
    stockValidoUnidades: redondear(stockValido),
    stockFabricaUnidades: redondear(stockFabrica),
    stockLocalesUnidades: redondear(stockLocales),
    stockPorVencerUnidades: redondear(stockPorVencer),
    aHacerUnidades: redondear(aHacer),
    aHacerDocenas: redondear(aHacer / 12),
    gramajeGxUnidad: s.Gramaje,
    kilosDeRelleno: redondear((aHacer * (Number(s.Gramaje) || 0)) / 1000)
  };
}

// suma por relleno los resultados de COCINA (varios sabores comparten relleno)
function agruparPorRelleno(filasCocina) {
  const porRelleno = {};
  filasCocina.forEach(f => {
    if (!porRelleno[f.relleno]) {
      porRelleno[f.relleno] = { relleno: f.relleno, diaCocina: f.diaCocina, diasQueCubre: f.diasQueCubre, sabores: [], kilosDeRelleno: 0 };
    }
    porRelleno[f.relleno].sabores.push({ sabor: f.sabor, aHacerUnidades: f.aHacerUnidades, kilosDeRelleno: f.kilosDeRelleno });
    porRelleno[f.relleno].kilosDeRelleno = redondear(porRelleno[f.relleno].kilosDeRelleno + f.kilosDeRelleno);
  });
  return Object.values(porRelleno);
}

function dedupAlertas(alertas) {
  const vistas = new Set();
  return alertas.filter(a => {
    const key = a.sabor + '|' + a.local + '|' + a.vencimiento;
    if (vistas.has(key)) return false;
    vistas.add(key);
    return true;
  });
}

// --- Todo lo demás (Dips, Postres, Topping, Cajita Criolla): mismo esquema
//     pero sin calendario ni reposo — objetivo de HOY menos stock vigente.
//     Ref_VentaDiaria para estos ítems está en UNIDADES directas (no docenas).
function calcularItemSimple(s, diaHoy, fechaHoy, refVenta, stock, alertasVencimiento, soloLocal) {
  let objetivoHoy = 0;
  refVenta.filter(v => v.Sabor === s.Sabor && (!soloLocal || v.Local === soloLocal)).forEach(v => {
    objetivoHoy += Number(v[diaHoy]) || 0;
  });

  // ojo: stockVigente necesita una FECHA (yyyy-MM-dd) para comparar contra el
  // vencimiento, no el nombre del día — por eso se pasa fechaHoy, no diaHoy.
  const { stockValido, stockPorVencer, stockFabrica, stockLocales } = stockVigente(s.Sabor, stock, fechaHoy, alertasVencimiento, soloLocal);
  const aReponer = Math.max(objetivoHoy - stockValido, 0);

  return {
    sabor: s.Sabor,
    categoria: s.Categoria,
    rubro: rubroDeSabor(s),
    tipoCalculo: 'Simple',
    tipoDisco: null,
    relleno: null,
    diaCocina: diaHoy,
    diaArmado: diaHoy,
    diasQueCubre: diaHoy,
    objetivoUnidades: redondear2(objetivoHoy),
    stockValidoUnidades: redondear2(stockValido),
    stockFabricaUnidades: redondear2(stockFabrica),
    stockLocalesUnidades: redondear2(stockLocales),
    stockPorVencerUnidades: redondear2(stockPorVencer),
    aHacerUnidades: redondear2(aReponer),
    aHacerDocenas: redondear(aReponer / 12),
    gramajeGxUnidad: null,
    kilosDeRelleno: null
  };
}

// Suma el stock de un sabor cuyo vencimiento sigue vigente en fechaLimite (>=),
// y separa el que ya no llega como alerta.
//
// OJO: cada carga de stock (por local o sector) es un RECUENTO de "cuánto
// queda" a esa fecha, no un lote que se suma a lo cargado la noche anterior.
// Por eso acá NO se suman todas las filas históricas de un sabor: para cada
// ubicación (Local) se toma solo su carga más reciente (Fecha_registro más
// alta) y se descartan sus cargas anteriores — quedan igual en la hoja Stock
// como historial, pero no se cuentan dos veces. Dentro de una misma carga
// (misma fecha, mismo local) sí pueden convivir varias filas — eso es
// justamente un mismo sabor con más de un lote/vencimiento cargado esa noche.
// Si se pasa `soloLocal`, además se filtra a esa única ubicación (para
// calcular el stock de UN local puntual, como en Envíos).
// STOCK QUE CUENTA PARA UNA FECHA: de cada lugar (local o sector de fábrica)
// se toma SOLO su carga de ese día o, si no hay, la de la noche anterior
// (fecha − 1). Esa carga es el recuento COMPLETO: lo que no figura en ella
// es 0. Si el lugar no cargó ni ese día ni el anterior, todo su stock es 0
// (no se arrastran cargas viejas). Confirmado con Carolina (29/09/2026).
function stockParaFecha(stock, fecha) {
  const desde = sumarDias(fecha, -1);
  const fechaDeFila = st => normalizarFecha(st.Fecha_registro);
  const cargaPorLugar = {};
  stock.forEach(st => {
    const f = fechaDeFila(st);
    if (f < desde || f > fecha) return;
    if (!cargaPorLugar[st.Local] || f > cargaPorLugar[st.Local]) cargaPorLugar[st.Local] = f;
  });
  return stock.filter(st => cargaPorLugar[st.Local] && fechaDeFila(st) === cargaPorLugar[st.Local]);
}

// STOCK QUE SE DESCUENTA DE UN LOTE DE PRODUCCIÓN (varios días de venta).
// `ventana` = [{ fecha, venta }] de cada día que cubre el lote.
//  - El stock que vence el ÚLTIMO día cubierto o después cuenta entero.
//  - El stock que vence ANTES (pero dentro de la ventana) cuenta hasta lo que
//    se puede vender en los días anteriores a su vencimiento, inclusive el
//    día que vence (primero se consume lo que vence antes). Lo que sobra de
//    ese lote es lo único que va a "por vencer".
// Antes se descartaba ENTERO todo lo que venciera antes del día siguiente al
// último cubierto: stock real de fábrica que vencía el sábado no se
// descontaba de un lote Viernes + Sábado. Corregido 02/10/2026 (Carolina).
function stockVigenteVentana(sabor, stock, ventana, alertasVencimiento, soloLocal) {
  let filas = stock.filter(st => st.Sabor === sabor);
  if (soloLocal) filas = filas.filter(st => st.Local === soloLocal);
  const ultimaFechaPorLocal = {};
  filas.forEach(st => {
    const f = normalizarFecha(st.Fecha_registro);
    if (!ultimaFechaPorLocal[st.Local] || f > ultimaFechaPorLocal[st.Local]) ultimaFechaPorLocal[st.Local] = f;
  });
  const lotes = filas
    .filter(st => normalizarFecha(st.Fecha_registro) === ultimaFechaPorLocal[st.Local])
    .map(st => ({ local: st.Local, cant: Number(st.Cantidad) || 0, venc: normalizarFecha(st.Fecha_vencimiento) }))
    .filter(l => l.cant > 0) // un 0 cargado a mano = "no hay"
    .sort((a, b) => (a.venc < b.venc ? -1 : a.venc > b.venc ? 1 : 0));

  const ultimoDia = ventana.length ? ventana[ventana.length - 1].fecha : '';
  let stockValido = 0;
  let stockPorVencer = 0;
  let stockFabrica = 0; // parte de stockValido que está en fábrica (el resto, en locales)
  let usadoCorto = 0; // lo ya descontado con lotes que vencen dentro de la ventana
  lotes.forEach(l => {
    if (l.venc >= ultimoDia) { stockValido += l.cant; if (esLugarFabrica(l.local)) stockFabrica += l.cant; return; }
    let ventaHastaVenc = 0;
    ventana.forEach(d => { if (d.fecha <= l.venc) ventaHastaVenc += d.venta; });
    const sirve = Math.min(l.cant, Math.max(ventaHastaVenc - usadoCorto, 0));
    usadoCorto += sirve;
    stockValido += sirve;
    if (esLugarFabrica(l.local)) stockFabrica += sirve;
    const sobra = l.cant - sirve;
    if (sobra > 0) {
      stockPorVencer += sobra;
      alertasVencimiento.push({ sabor, local: l.local, cantidad: redondear(sobra), vencimiento: l.venc });
    }
  });
  return { stockValido, stockPorVencer, stockFabrica, stockLocales: stockValido - stockFabrica };
}

// true si el lugar de stock es un sector de fábrica ("Fábrica - ...") y no un local
function esLugarFabrica(lugar) {
  return LOCALES.indexOf(String(lugar)) === -1;
}

function stockVigente(sabor, stock, fechaLimite, alertasVencimiento, soloLocal) {
  const fechaDeFila = st => st.Fecha_registro instanceof Date
    ? Utilities.formatDate(st.Fecha_registro, TZ, 'yyyy-MM-dd')
    : String(st.Fecha_registro);

  let filas = stock.filter(st => st.Sabor === sabor);
  if (soloLocal) filas = filas.filter(st => st.Local === soloLocal);

  // última fecha de carga por ubicación
  const ultimaFechaPorLocal = {};
  filas.forEach(st => {
    const f = fechaDeFila(st);
    if (!ultimaFechaPorLocal[st.Local] || f > ultimaFechaPorLocal[st.Local]) {
      ultimaFechaPorLocal[st.Local] = f;
    }
  });

  // solo cuentan las filas de la carga más reciente de su propia ubicación
  const filasVigentes = filas.filter(st => fechaDeFila(st) === ultimaFechaPorLocal[st.Local]);

  let stockValido = 0;
  let stockPorVencer = 0;
  let stockFabrica = 0;
  filasVigentes.forEach(st => {
    const cant = Number(st.Cantidad) || 0;
    const venc = st.Fecha_vencimiento instanceof Date
      ? Utilities.formatDate(st.Fecha_vencimiento, TZ, 'yyyy-MM-dd')
      : String(st.Fecha_vencimiento);
    if (cant <= 0) return; // un 0 cargado a mano = "no hay" (no es alerta de vencimiento)
    if (venc >= fechaLimite) {
      stockValido += cant;
      if (esLugarFabrica(st.Local)) stockFabrica += cant;
    } else {
      stockPorVencer += cant;
      alertasVencimiento.push({ sabor, local: st.Local, cantidad: cant, vencimiento: venc });
    }
  });
  return { stockValido, stockPorVencer, stockFabrica, stockLocales: stockValido - stockFabrica };
}

// ---------------------------------------------------------------------------
// Planificación editable (Ref_VentaDiaria) — ver y actualizar objetivos
// ---------------------------------------------------------------------------

function listarPlanificacion(local) {
  const filas = leerHoja('Ref_VentaDiaria').filter(v => v.Local === local);
  const refSabores = leerHoja('Ref_Sabores');
  const rubroDe = {};
  refSabores.forEach(s => { rubroDe[s.Sabor] = rubroDeSabor(s); });
  filas.forEach(f => { f.Categoria = rubroDe[f.Sabor] || ''; });
  filas.sort((a, b) => (a.Categoria + a.Sabor).localeCompare(b.Categoria + b.Sabor));
  return { local, filas };
}

/**
 * data = { local, filas: [{ sabor, Lunes, Martes, ..., Domingo }, ...] }
 *
 * REEMPLAZA la planificación del local: primero pone en 0 todos los días de
 * TODAS las filas de ese local, y recién después pisa con los valores nuevos
 * las filas que vinieron en "data.filas". Así, un sabor que no viene en el
 * nuevo import no se queda con el número de la carga anterior.
 *
 * Si un sabor de "data.filas" no tiene fila en Ref_VentaDiaria para ese local
 * (ej. un sabor nuevo, o uno que cambió de nombre en Ref_Sabores), se crea la
 * fila en vez de perder el dato en silencio.
 */
function actualizarPlanificacion(data) {
  // Todo en memoria y UNA sola escritura. Antes escribía celda por celda
  // (~2.000 escrituras por local) y Google cortaba el proceso a la mitad:
  // se guardaban las empanadas pero toppings, dips, postres y cajitas
  // quedaban en 0. Corregido el 29/09/2026.
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Ref_VentaDiaria');
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const colLocal = headers.indexOf('Local');
  const colSabor = headers.indexOf('Sabor');
  const colesDias = DIAS.map(d => headers.indexOf(d));
  if (colLocal === -1 || colSabor === -1 || colesDias.some(c => c === -1)) {
    throw new Error('A la hoja Ref_VentaDiaria le faltan columnas (Local, Sabor y los 7 días).');
  }

  // 1) este local vuelve a 0 en todos los días, para todos los sabores
  const filaPorSabor = {};
  for (let i = 1; i < values.length; i++) {
    if (values[i][colLocal] !== data.local) continue;
    colesDias.forEach(col => { values[i][col] = 0; });
    filaPorSabor[values[i][colSabor]] = i;
  }

  // 2) pisa con los valores nuevos; los que no tienen fila se crean al final
  let actualizados = 0;
  const nuevasFilas = [];
  (data.filas || []).forEach(fila => {
    const i = filaPorSabor[fila.sabor];
    if (i !== undefined) {
      DIAS.forEach((d, k) => { values[i][colesDias[k]] = Number(fila[d]) || 0; });
      actualizados++;
    } else {
      const row = new Array(headers.length).fill('');
      row[colLocal] = data.local;
      row[colSabor] = fila.sabor;
      DIAS.forEach((d, k) => { row[colesDias[k]] = Number(fila[d]) || 0; });
      nuevasFilas.push(row);
    }
  });

  // 3) una sola escritura de toda la tabla (+ las filas nuevas al final)
  if (values.length > 1) sheet.getRange(2, 1, values.length - 1, headers.length).setValues(values.slice(1));
  if (nuevasFilas.length) sheet.getRange(values.length + 1, 1, nuevasFilas.length, headers.length).setValues(nuevasFilas);
  limpiarCacheHojas(['Ref_VentaDiaria']);
  return { ok: true, filas_actualizadas: actualizados + nuevasFilas.length, filas_creadas: nuevasFilas.length };
}

// ---------------------------------------------------------------------------
// PLAN DEL DÍA CONGELADO ("Confirmar plan del día") — pedido por Carolina
// (05/10/2026). Mientras no se confirma, "Qué producir hoy" y la orden de
// envío se calculan en vivo (cambian cada vez que se carga o corrige stock, o
// se importa otra proyección). Al confirmar se guarda una FOTO de los datos
// con los que se calcula: el stock cargado hasta ese momento y la proyección
// de ventas. Desde ahí todos los cálculos de ESE día (Producción, Cocina,
// ollas, discos, "para mañana" y la orden de envío a los locales) usan la
// foto, así que no se mueven aunque después se cargue stock nuevo. El stock
// que se carga después se guarda igual en la hoja Stock y cuenta para el día
// siguiente. "Recalcular" saca una foto nueva.
//   - Quién y a qué hora confirmó: hoja Cierres (Pantalla "Plan", Clave "dia").
//   - La foto: hoja "PlanDia" (se crea sola; guarda solo los últimos días).
// El % de Cocina y lo que se registra como producido NO se congelan.
// ---------------------------------------------------------------------------
let PLAN_ANCLA = null;       // día del pedido en curso
const MEMO_PLAN = {};        // foto ya leída en este pedido, por fecha
const HEADERS_PLAN = ['Fecha', 'Parte', 'Datos'];
const PLAN_TROZO = 40000;    // una celda de Sheets admite hasta 50.000 caracteres
const PLAN_DIAS_GUARDADOS = 4;

function hojaPlan() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('PlanDia');
  if (!sheet) {
    sheet = ss.insertSheet('PlanDia');
    sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS_PLAN.length).setNumberFormat('@');
    sheet.getRange(1, 1, 1, HEADERS_PLAN.length).setValues([HEADERS_PLAN]);
  }
  return sheet;
}

// { confirmado, responsable, hora } si el plan de esa fecha está confirmado; si no, null
function estadoPlanDia(fecha) {
  const c = obtenerCierre(fecha, 'Plan', 'dia');
  if (!c) return null;
  if (!fotoPlanDia(fecha)) return null; // confirmado pero sin foto (muy viejo): se calcula en vivo
  return { confirmado: true, responsable: c.responsable, hora: c.hora };
}

// la foto guardada de esa fecha: { stock: [filas], venta: [filas] } o null
function fotoPlanDia(fecha) {
  if (fecha in MEMO_PLAN) return MEMO_PLAN[fecha];
  let foto = null;
  try {
    if (obtenerCierre(fecha, 'Plan', 'dia')) {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PlanDia');
      if (sheet && sheet.getLastRow() > 1) {
        const values = sheet.getDataRange().getValues();
        const partes = [];
        for (let i = 1; i < values.length; i++) {
          if (normalizarFecha(values[i][0]) === fecha) partes[Number(values[i][1])] = String(values[i][2]);
        }
        if (partes.length) {
          const d = JSON.parse(partes.join(''));
          foto = {
            stock: d.stock.map(r => ({ Fecha_registro: r[0], Local: r[1], Sabor: r[2], Cantidad: r[3], Fecha_vencimiento: r[4] })),
            venta: d.venta.map(r => {
              const o = { Sabor: r[0], Local: r[1] };
              DIAS.forEach((dia, k) => { o[dia] = r[2 + k]; });
              return o;
            })
          };
        }
      }
    }
  } catch (err) { foto = null; }
  MEMO_PLAN[fecha] = foto;
  return foto;
}

// stock y proyección con los que se calcula: la foto del plan confirmado del
// día que se está mirando o, si no hay, lo que está cargado ahora.
function stockBase(fechaCalculo) {
  const foto = fotoPlanDia(PLAN_ANCLA || hoy());
  const filas = foto ? foto.stock : leerHojaParaFecha('Stock', 'Fecha_registro', sumarDias(fechaCalculo, -1));
  return stockParaFecha(filas, fechaCalculo);
}
function ventaBase() {
  const foto = fotoPlanDia(PLAN_ANCLA || hoy());
  return foto ? foto.venta : leerHoja('Ref_VentaDiaria');
}

// data = { fecha, responsable, recalcular }
function confirmarPlanDia(data) {
  const fecha = data.fecha || hoy();
  const responsable = String(data.responsable || '').trim();
  if (!responsable) throw new Error('Falta indicar quién confirma el plan del día.');
  const actual = estadoPlanDia(fecha);
  if (actual && !data.recalcular) return { ok: true, yaEstaba: true, plan: actual };

  // foto de lo cargado AHORA (stock de ayer y de hoy + toda la proyección)
  const desde = sumarDias(fecha, -1);
  const stock = leerHojaParaFecha('Stock', 'Fecha_registro', desde)
    .filter(st => { const f = normalizarFecha(st.Fecha_registro); return f >= desde && f <= fecha; })
    .map(st => [normalizarFecha(st.Fecha_registro), st.Local, st.Sabor, Number(st.Cantidad) || 0, normalizarFecha(st.Fecha_vencimiento)]);
  const venta = leerHojaDirecto('Ref_VentaDiaria')
    .map(v => [v.Sabor, v.Local].concat(DIAS.map(d => Number(v[d]) || 0)));
  const json = JSON.stringify({ stock: stock, venta: venta });

  const sheet = hojaPlan();
  // se borra la foto anterior de esta fecha y las de días viejos
  const limite = sumarDias(hoy(), -PLAN_DIAS_GUARDADOS);
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    const f = normalizarFecha(values[i][0]);
    if (f === fecha || f < limite) sheet.deleteRow(i + 1);
  }
  const filas = [];
  for (let i = 0, n = 0; i < json.length; i += PLAN_TROZO, n++) filas.push([fecha, String(n), json.substring(i, i + PLAN_TROZO)]);
  sheet.getRange(sheet.getLastRow() + 1, 1, filas.length, HEADERS_PLAN.length).setValues(filas);

  delete MEMO_PLAN[fecha];
  Object.keys(MEMO_CALCULAR_TODO).forEach(k => { delete MEMO_CALCULAR_TODO[k]; });
  registrarCierre(fecha, 'Plan', 'dia', responsable, stock.length);
  return { ok: true, recalculado: !!(actual && data.recalcular), plan: estadoPlanDia(fecha), filasStock: stock.length };
}

// PRODUCTOS QUE EL SISTEMA DA DE ALTA SOLO en Ref_Sabores si todavía no
// están (así no hay que tocar la planilla a mano). SALSA FILETTO: topping en
// LITROS, con decimales — pedido por Carolina (05/10/2026).
const PRODUCTOS_BASE = [
  { Sabor: 'SALSA FILETTO', Categoria: 'Topping', Reposo: 'No', TipoCalculo: 'Simple' }
];
function asegurarProductosBase() {
  try {
    const existentes = leerHoja('Ref_Sabores').map(s => normalizarTexto(s.Sabor));
    const faltan = PRODUCTOS_BASE.filter(p => existentes.indexOf(normalizarTexto(p.Sabor)) === -1);
    if (!faltan.length) return;
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return;
    try {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Ref_Sabores');
      const headers = headersDe(sheet);
      const yaEstan = leerHojaDirecto('Ref_Sabores').map(s => normalizarTexto(s.Sabor));
      const filas = faltan.filter(p => yaEstan.indexOf(normalizarTexto(p.Sabor)) === -1).map(p => {
        const fila = new Array(headers.length).fill('');
        Object.keys(p).forEach(k => setPorHeader(fila, headers, k, p[k]));
        return fila;
      });
      if (filas.length) sheet.getRange(sheet.getLastRow() + 1, 1, filas.length, headers.length).setValues(filas);
      limpiarCacheHojas(['Ref_Sabores']);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {}
}

// 2 decimales: para los ítems que se manejan con decimales (SALSA FILETTO, en litros)
function redondear2(n) {
  return Math.round(n * 100) / 100;
}

function redondear(n) {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// CIERRES — "Guardar y enviar" / "Reabrir". Hoja "Cierres" (se crea sola):
// una fila por cada carga cerrada (Fecha + Pantalla + Clave), con quién la
// envió, a qué hora y cuántos ítems tenía. Es a la vez el candado de la
// carga (Stock, Discos, Envíos) y un registro para indicadores: queda la
// hora de envío y, si se reabrió, la hora de reapertura. Nunca se borran
// filas — reabrir solo cambia el Estado. Pantallas: Stock (clave = local),
// Envios (clave = local), Discos, Produccion (clave = Turno), Cocina (clave
// = receta). Confirmado con Carolina (29/09/2026).
// ---------------------------------------------------------------------------
const HEADERS_CIERRES = ['Fecha', 'Pantalla', 'Clave', 'Estado', 'Responsable', 'Hora_envio', 'Items', 'Hora_reapertura'];

function hojaCierres() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Cierres');
  if (!sheet) {
    sheet = ss.insertSheet('Cierres');
    // todo como texto, para que Sheets no convierta fechas/horas a su gusto
    sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS_CIERRES.length).setNumberFormat('@');
    sheet.getRange(1, 1, 1, HEADERS_CIERRES.length).setValues([HEADERS_CIERRES]);
  }
  return sheet;
}

function horaAhora() {
  return Utilities.formatDate(new Date(), TZ, 'HH:mm');
}

function registrarCierre(fecha, pantalla, clave, responsable, items) {
  MEMO_CIERRES = null;
  const sheet = hojaCierres();
  const headers = headersDe(sheet);
  const fila = new Array(headers.length).fill('');
  const hora = horaAhora();
  setPorHeader(fila, headers, 'Fecha', fecha);
  setPorHeader(fila, headers, 'Pantalla', pantalla);
  setPorHeader(fila, headers, 'Clave', clave);
  setPorHeader(fila, headers, 'Estado', 'Enviado');
  setPorHeader(fila, headers, 'Responsable', responsable || '');
  setPorHeader(fila, headers, 'Hora_envio', hora);
  setPorHeader(fila, headers, 'Items', String(items == null ? '' : items));
  upsertFila(sheet, headers, { Fecha: fecha, Pantalla: pantalla, Clave: clave }, fila);
  return { enviado: true, responsable: responsable || '', hora, items };
}

function reabrirCierre(fecha, pantalla, clave) {
  MEMO_CIERRES = null;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Cierres');
  if (!sheet) return;
  const headers = headersDe(sheet);
  const existente = buscarFila(sheet, headers, { Fecha: fecha, Pantalla: pantalla, Clave: clave });
  if (!existente) return;
  sheet.getRange(existente.rowIndex + 1, headers.indexOf('Estado') + 1).setValue('Reabierto');
  sheet.getRange(existente.rowIndex + 1, headers.indexOf('Hora_reapertura') + 1).setValue(horaAhora());
}

// null si esa carga nunca se envió o se reabrió.
// la hoja Cierres se lee UNA vez por pedido (antes se releía por cada local)
let MEMO_CIERRES = null;
function valoresCierres() {
  if (MEMO_CIERRES) return MEMO_CIERRES;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Cierres');
  MEMO_CIERRES = sheet ? sheet.getDataRange().getValues() : [[]];
  return MEMO_CIERRES;
}

function obtenerCierre(fecha, pantalla, clave) {
  const values = valoresCierres();
  const headers = values[0];
  const cF = headers.indexOf('Fecha'), cP = headers.indexOf('Pantalla'), cC = headers.indexOf('Clave');
  if (cF === -1) return null;
  let v = null;
  for (let i = 1; i < values.length; i++) {
    if (values[i][cP] === pantalla && String(values[i][cC]) === String(clave) && normalizarFecha(values[i][cF]) === normalizarFecha(fecha)) { v = values[i]; break; }
  }
  if (!v) return null;
  if (v[headers.indexOf('Estado')] !== 'Enviado') return null;
  const hora = v[headers.indexOf('Hora_envio')];
  return {
    enviado: true,
    puedeReabrir: esUltimoCierre(fecha, pantalla, clave),
    responsable: String(v[headers.indexOf('Responsable')] || ''),
    hora: hora instanceof Date ? Utilities.formatDate(hora, TZ, 'HH:mm') : String(hora || ''),
    items: Number(v[headers.indexOf('Items')]) || 0
  };
}

// Solo se puede reabrir la ÚLTIMA carga enviada de cada lugar (pedido por
// Carolina, 29/09/2026): si hay un envío de fecha posterior para la misma
// pantalla y clave, las anteriores quedan cerradas para siempre.
function esUltimoCierre(fecha, pantalla, clave) {
  const values = valoresCierres();
  if (values.length < 2) return true;
  const h = values[0];
  const cF = h.indexOf('Fecha'), cP = h.indexOf('Pantalla'), cC = h.indexOf('Clave');
  const f = normalizarFecha(fecha);
  return !values.slice(1).some(r => r[cP] === pantalla && String(r[cC]) === String(clave) && normalizarFecha(r[cF]) > f);
}
function exigirUltimoCierre(fecha, pantalla, clave) {
  if (!esUltimoCierre(fecha, pantalla, clave)) {
    throw new Error('Solo se puede reabrir la última carga enviada — esta ya tiene una posterior.');
  }
}

// "Reabrir" de Stock, Discos y Envíos. data = { pantalla, fecha, clave }
function reabrirCarga(data) {
  const fecha = data.fecha || hoy();
  if (['Stock', 'Discos', 'Envios'].indexOf(data.pantalla) === -1) throw new Error('Pantalla desconocida: ' + data.pantalla);
  exigirUltimoCierre(fecha, data.pantalla, data.clave);
  reabrirCierre(fecha, data.pantalla, data.clave);
  // Envíos: lo que el local todavía no recibió vuelve a "Preparando" (deja
  // de aparecerle en Confirmar recepción hasta que se vuelva a enviar).
  if (data.pantalla === 'Envios') {
    const { sheet, headers } = hojaEnvios();
    const tabla = leerTabla(sheet);
    const values = tabla.values;
    const cambiadas = [];
    const cEstado = headers.indexOf('Estado'), cLocal = headers.indexOf('Local'), cOrigen = headers.indexOf('Origen');
    const cFecha = headers.indexOf('Fecha_envio'), cRecep = headers.indexOf('Fecha_recepcion');
    const partes = String(data.clave).split('>');
    const origen = partes.length === 2 ? partes[0] : '';
    const destino = partes.length === 2 ? partes[1] : partes[0];
    for (let i = 1; i < values.length; i++) {
      if (values[i][cLocal] === destino && String(values[i][cOrigen] || '') === origen && normalizarFecha(values[i][cFecha]) === normalizarFecha(fecha) && !values[i][cRecep]) {
        values[i][cEstado] = 'Preparando';
        cambiadas.push(i);
      }
    }
    escribirBloque(sheet, tabla, cambiadas, cEstado, cEstado);
  }
  return { ok: true, reabierto: true };
}
