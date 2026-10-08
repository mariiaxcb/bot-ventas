/**
 * Pruebas del parser de mensajes del comprador.
 *
 * Estos tests importan `parser.ts`, el mismo archivo que usa el bot: si el
 * parser cambia, estas pruebas tienen que cambiar con él.
 *
 * Ejecutar con: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  esSolicitudDeCancelacion,
  limpiarUsername,
  mencionaTiktok,
  normalizar,
  parseReservationMessage,
  quitarPalabraTiktok,
  type DatosReserva,
} from './parser'

/** Estilo de una sola línea, para leer la tabla completa de un vistazo. */
function resumen(datos: DatosReserva | null): string {
  if (!datos) return 'sin datos'

  const user = datos.username ?? '-'
  const code = datos.productCode ?? '-'

  return `${user} + ${code}`
}

// ------------------------------------------------------------------ puerta

test('la palabra de apertura se detecta sin importar mayusculas ni acentos', () => {
  for (const texto of ['tiktok', 'Tiktok', 'TIKTOK', ' TikTok ', 'vengo por TikTok']) {
    assert.equal(mencionaTiktok(texto), true, `deberia detectar: ${texto}`)
  }

  for (const texto of ['hola', 'productos', 'raton', '']) {
    assert.equal(mencionaTiktok(texto), false, `no deberia detectar: ${texto}`)
  }
})

test('la palabra de apertura se quita pero no rompe un usuario que la contiene', () => {
  assert.equal(quitarPalabraTiktok('Tiktok'), '')
  assert.equal(quitarPalabraTiktok('tiktok porfa'), 'porfa')
  assert.equal(quitarPalabraTiktok('tiktok pepito123 mouseX6'), 'pepito123 mouseX6')
  // "tiktok_shop" es un usuario: la palabra va pegada y no debe tocarse.
  assert.equal(quitarPalabraTiktok('tiktok_shop'), 'tiktok_shop')
})

test('quitar la palabra de apertura no aplana los saltos de linea', () => {
  // Si se aplanaran, las dos etiquetas del formato quedarian en una sola linea
  // y el nombre de usuario se llevaria pegado el codigo de producto.
  const texto = 'tiktok\nnombre de usuario: pepito123\ncodigo de producto: mouseX6'

  assert.equal(
    quitarPalabraTiktok(texto),
    'nombre de usuario: pepito123\ncodigo de producto: mouseX6',
  )
})

test('el formato completo sigue siendo legible despues de quitar "tiktok"', () => {
  // Es el camino real: el bot pide este formato y el comprador lo copia tal
  // cual, a veces con la palabra de apertura al principio y a veces en una sola
  // linea, porque en un celular es facil que se borre el salto.
  const textos = [
    'nombre de usuario: pepito123\ncodigo de producto: mouseX6',
    'tiktok\nnombre de usuario: pepito123\ncodigo de producto: mouseX6',
    'Tiktok nombre de usuario: pepito123 codigo de producto: mouseX6',
    'nombre de usuario: pepito123 codigo de producto: mouseX6',
    'tiktok nombre de usuario: @rashad_barra\ncodigo de producto: mio123',
  ]

  for (const texto of textos) {
    const datos = parseReservationMessage(quitarPalabraTiktok(texto))

    const esBarra = texto.includes('rashad_barra')

    assert.notEqual(datos, null, `deberia encontrar datos en: ${texto}`)
    assert.equal(datos?.username, esBarra ? 'rashad_barra' : 'pepito123', texto)
    assert.equal(datos?.productCode, esBarra ? 'MIO123' : 'MOUSEX6', texto)
  }
})

test('la cancelacion se reconoce en varias formas', () => {
  for (const texto of [
    'Cancelar Reserva',
    'cancelar reserva',
    'cancelar',
    'CANCELAR POR FAVOR',
    'ya no quiero el producto',
  ]) {
    assert.equal(esSolicitudDeCancelacion(texto), true, `deberia: ${texto}`)
  }

  for (const texto of ['cancelado', 'no cancelar', 'tiktok mouseX6']) {
    assert.equal(esSolicitudDeCancelacion(texto), false, `no deberia: ${texto}`)
  }
})

test('el nombre de usuario se limpia igual que como lo guarda el backend', () => {
  assert.equal(limpiarUsername('@Pepito123'), 'pepito123')
  assert.equal(limpiarUsername('  RASHAD_BARRA '), 'rashad_barra')
})

test('normalizar quita acentos y mayusculas', () => {
  assert.equal(normalizar('CÓDIGO'), 'codigo')
  assert.equal(normalizar('ÁÉÍÓÚ'), 'aeiou')
})

// ------------------------------------------------------- formato con etiqueta

test('formato completo en un solo mensaje', () => {
  const datos = parseReservationMessage(
    'nombre de usuario: pepito123\ncodigo de producto: mouseX6',
  )

  assert.equal(datos?.username, 'pepito123')
  assert.equal(datos?.productCode, 'MOUSEX6')
})

test('un campo por mensaje, que es como se escribe en un chat', () => {
  const soloUsuario = parseReservationMessage('nombre de usuario: @pepito123')
  assert.equal(soloUsuario?.username, 'pepito123')
  assert.equal(soloUsuario?.productCode, null)

  const soloCodigo = parseReservationMessage('codigo de producto: mouseX6')
  assert.equal(soloCodigo?.username, null)
  assert.equal(soloCodigo?.productCode, 'MOUSEX6')
})

test('las etiquetas solas no cuentan como datos', () => {
  // Es el caso de quien copia el formato del bot y no lo completa. Si aqui se
  // leyera algo, el bot creeria que ya tiene datos y nunca los pediria.
  assert.equal(
    parseReservationMessage('nombre de usuario:\ncodigo de producto:'),
    null,
  )

  assert.equal(
    parseReservationMessage('nombre de usuario: \n codigo de producto: '),
    null,
  )

  assert.equal(parseReservationMessage('usuario:\nproducto:'), null)
})

test('el valor de un campo no puede ser la etiqueta de al lado', () => {
  const datos = parseReservationMessage(
    'nombre de usuario: codigo de producto:',
  )

  assert.equal(datos, null)
})

// --------------------------------------------------------- mensajes sin etiqueta

test('los dos datos sueltos se aceptan en dos lineas o separados', () => {
  const esperado = { username: 'pepito123', productCode: 'MOUSEX6' }

  assert.deepEqual(parseReservationMessage('pepito123\nmouseX6'), esperado)
  assert.deepEqual(parseReservationMessage('pepito123 mouseX6'), esperado)
  assert.deepEqual(parseReservationMessage('pepito123, mouseX6'), esperado)
  assert.deepEqual(parseReservationMessage('pepito123 | mouseX6'), esperado)
})

test('una palabra de cortesia delante no estorba', () => {
  assert.deepEqual(parseReservationMessage('Hola pepito123 mouseX6'), {
    username: 'pepito123',
    productCode: 'MOUSEX6',
  })
})

test('un token suelto jamas se toma como dato', () => {
  // "pepito123" y "mouseX6" por separado son indistinguibles entre si. Adivinar
  // convertiria medio dato en una busqueda de reserva que no existe, y el
  // comprador veria un error en vez de que se le pidan los dos datos.
  assert.equal(parseReservationMessage('pepito123'), null)
  assert.equal(parseReservationMessage('@rashad_barra'), null)
  assert.equal(parseReservationMessage('mouseX6'), null)
  assert.equal(parseReservationMessage('josefina'), null)
})

test('los saludos NO son datos, sin importar de donde vengan', () => {
  // "Bola" es como se saluda en Bolivia y "Hi" en un chat. Ninguno de los dos
  // debe convertirse en un nombre de usuario: si lo fuera, el bot responderia
  // buscando una reserva que no existe en vez de pedir el formato.
  const saludos = [
    'Bola',
    'Jola',
    'Hola',
    'Holas',
    'Hi',
    'Hey',
    'Hello',
    'Que tal',
    'Buenas tardes',
    'qwerty',
    'asdf',
    'q',
    'ok',
    'ok gracias',
    'hola gracias',
    'gracias',
    'saludos',
    'wenas',
  ]

  for (const saludo of saludos) {
    assert.equal(
      parseReservationMessage(saludo),
      null,
      `no deberia tomar "${saludo}" como dato`,
    )
  }
})

test('una frase normal no se convierte en datos de reserva', () => {
  const frases = [
    'quiero el mouse',
    'quiero saber si tienen el mouse disponible para regalar a mi hermana',
    'tienen disponibles las camisas?',
    'como estan los precios de los zapatillas',
    'cancelar la reserva por favor',
  ]

  for (const frase of frases) {
    assert.equal(
      parseReservationMessage(frase),
      null,
      `no deberia tomar "${frase}" como dato`,
    )
  }
})

test('un codigo suelto sin usuario no alcanza para buscar una reserva', () => {
  // Aceptarlo haria que el bot buscara una reserva llamada "mousex6".
  assert.equal(parseReservationMessage('mouseX6'), null)
  assert.equal(parseReservationMessage('mouse'), null)
})

test('el usuario de un mensaje suelto tiene que parecer un usuario', () => {
  // Sin esta regla "hola gracias" se leeria como usuario "hola".
  assert.equal(parseReservationMessage('hola gracias'), null)
  assert.equal(parseReservationMessage('saludos hola'), null)
  assert.equal(parseReservationMessage('ola q'), null)
})

test('el ruido despues de los dos datos se tolera', () => {
  // El comprador ya dio lo que importa: el bot busca la reserva.
  assert.deepEqual(parseReservationMessage('pepito123 mouseX6 gracias'), {
    username: 'pepito123',
    productCode: 'MOUSEX6',
  })
})

test('mas de tres palabras ya no es una lista de datos', () => {
  // Aqui buscar un par dentro de la frase inventaria una combinacion.
  assert.equal(parseReservationMessage('hola que tal pepito123 mouseX6'), null)
  assert.equal(
    parseReservationMessage('quiero el mouse X6 para pepito123 de una vez'),
    null,
  )
})

test('demasiadas palabras no se interpretan', () => {
  assert.equal(
    parseReservationMessage('hola que tal como estas pepito123 mouseX6'),
    null,
  )
})

// ------------------------------------------------------------------ resumen

test('tabla resumen de los casos que el comprador escribe de verdad', () => {
  const casos: [string, string][] = [
    ['abre el flujo', 'Tiktok'],
    ['saludo local', 'Bola'],
    ['saludo corto', 'Hi'],
    ['formato vacio', 'nombre de usuario:\ncodigo de producto:'],
    ['un solo campo', 'nombre de usuario: pepito123'],
    ['los dos campos', 'nombre de usuario: pepito123\ncodigo de producto: mouseX6'],
    ['datos sueltos', 'pepito123\nmouseX6'],
    ['datos con saludo', 'Hola pepito123 mouseX6'],
    ['codigo suelto', 'mouseX6'],
  ]

  const tabla = casos
    .map(([nombre, texto]) => {
      const datos =
        nombre === 'abre el flujo'
          ? null
          : parseReservationMessage(quitarPalabraTiktok(texto))

      return `  ${nombre.padEnd(16)} ${resumen(datos).padEnd(28)} ${JSON.stringify(texto)}`
    })
    .join('\n')

  console.log(`\n${tabla}\n`)
})