/**
 * Pruebas de los textos y su secuencia.
 *
 * Estos tests importan `mensajes.ts`, el mismo archivo que usa el bot.
 *
 * Ejecutar con: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FORMATO_RESERVA,
  mensajesParaPedirDatos,
  mensajesReservaPerdida,
} from './mensajes'

/** El saludo largo, que identifica a un primer aviso. */
const SALUDO = FORMATO_RESERVA[0]

test('el saludo largo solo sale al abrir el flujo con "tiktok"', () => {
  // Este es el error que se reportó: tras escribir "tiktok", el comprador
  // saludaba ("Bola", "Jola", "Hi") y el bot le volvía a mandar el saludo
  // completo, como si recién empezara. Parece un bot que se reinició.
  for (let veces = 0; veces < 6; veces++) {
    const mensajes = mensajesParaPedirDatos(veces, false)

    assert.equal(
      mensajes.includes(SALUDO),
      false,
      `el saludo no debe reaparecer en el aviso ${veces + 1}`,
    )
  }
})

test('el primer mensaje tras "tiktok" si es el saludo y el formato', () => {
  assert.deepEqual(mensajesParaPedirDatos(0, true), FORMATO_RESERVA)
})

test('el formato siempre aparece en los dos primeros avisos', () => {
  for (const veces of [0, 1]) {
    for (const abre of [true, false]) {
      const joined = mensajesParaPedirDatos(veces, abre).join('\n')

      assert.match(joined, /nombre de usuario/, `aviso ${veces + 1}`)
      assert.match(joined, /codigo de producto/, `aviso ${veces + 1}`)
      assert.match(
        joined,
        /pepito123/,
        `debe haber un ejemplo en el aviso ${veces + 1}`,
      )
    }
  }
})

test('nunca se pide un solo campo', () => {
  // Pedir solo el que falta hacia que el comprador conteste con un dato suelto,
  // que el bot tomaba por el campo contrario, y la reserva no se encontraba.
  for (let veces = 0; veces < 6; veces++) {
    for (const abre of [true, false]) {
      const joined = mensajesParaPedirDatos(veces, abre)
        .join('\n')
        .toLowerCase()

      assert.doesNotMatch(
        joined,
        /ahora envia/,
        `no debe pedir un campo suelto en el aviso ${veces + 1}`,
      )
    }
  }
})

test('la escalera acorta los mensajes a medida que insistir no sirve', () => {
  const largo = mensajesParaPedirDatos(1, false).length
  const medio = mensajesParaPedirDatos(2, false).length
  const corto = mensajesParaPedirDatos(3, false).length

  assert.equal(largo, 3, 'el segundo aviso lleva ejemplo')
  assert.equal(medio, 1, 'el tercero pide la accion y ya')
  assert.equal(corto, 2, 'el cuarto ofrece hablar con el vendedor')
})

test('a partir del cuarto aviso se ofrece hablar con el vendedor', () => {
  for (const veces of [3, 4, 10]) {
    assert.match(
      mensajesParaPedirDatos(veces, false).join('\n'),
      /vendedor del live/,
      `aviso ${veces + 1}`,
    )
  }
})

test('el numero de intentos que se dice al comprador va por delante', () => {
  assert.match(mensajesParaPedirDatos(2, false).join('\n'), /3 veces/)
  assert.match(mensajesParaPedirDatos(3, false).join('\n'), /4 veces/)
})

test('al perder la reserva se dice como volver a empezar', () => {
  const mensajes = mensajesReservaPerdida().join('\n')

  assert.match(mensajes, /Perdio la reserva/)
  assert.match(mensajes, /tiktok/)
})

test('ningun texto lleva emojis ni acentos', () => {
  const todos = [
    ...FORMATO_RESERVA,
    ...mensajesParaPedirDatos(0, true),
    ...mensajesParaPedirDatos(1, false),
    ...mensajesParaPedirDatos(2, false),
    ...mensajesParaPedirDatos(3, false),
    ...mensajesReservaPerdida(),
  ]

  for (const texto of todos) {
    assert.doesNotMatch(texto, /[\u{1F300}-\u{1FAFF}]/u, `emoji en: ${texto}`)
    assert.doesNotMatch(texto, /[\u00C0-\u00FF]/u, `acento en: ${texto}`)
  }
})

test('tabla resumen de la conversación completa', () => {
  const pasos = [
    '1. escribe "tiktok"',
    '2. "Bola"',
    '3. "pepito123"',
    '4. "mouseX6"',
    '5. "Hola"',
    '6. "qwerty"',
  ]

  const filas = pasos.map((paso, indice) => {
    const veces = indice === 0 ? 0 : indice
    const mensajes = mensajesParaPedirDatos(veces, indice === 0)
    const resumen =
      mensajes.length === FORMATO_RESERVA.length &&
      mensajes[0] === FORMATO_RESERVA[0]
        ? 'saludo + formato + ejemplo'
        : mensajes.length === 3
          ? 'repite con otro ejemplo'
          : mensajes.length === 2
            ? 'pide accion + ofrece vendedor'
            : 'pide accion, directo'

    return `  ${paso.padEnd(22)} ${resumen}`
  })

  console.log(`\n${filas.join('\n')}\n`)
})
