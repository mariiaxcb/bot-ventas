/**
 * Los textos que el bot manda al comprador.
 *
 * Viven aparte de `index.ts` por el mismo motivo que el parser: son la parte
 * que más se ha tocado y la que más ha molestado al comprador. Aquí se pueden
 * leer y probar sin levantar la conexión de WhatsApp.
 *
 * Regla de la casa: sin emojis y sin acentos. Los acentos se ven rotos en
 * algunos celulares y el emoji no aporta nada en un aviso de tienda.
 */

/** Los dos datos que hay que enviar. Se muestra en cuanto alguien escribe. */
export const FORMATO_RESERVA = [
  'Gracias por comunicarte con Tienda LiveSales, Si realizaste una reserva por tiktok, por favor envianos la siguiente informacion en este formato:',
  'nombre de usuario:\ncodigo de producto:',
  'Por ejemplo:\n\nnombre de usuario: pepito123\ncodigo de producto: mouseX6',
]

/**
 * Segundo aviso: no llegó nada legible.
 *
 * Muestra el mismo formato que el saludo, pero con las dos líneas ya escritas y
 * una explicación de cuál es cuál. Es lo que pedía el comprador cuando no
 * entendía el formato vacío, y evita el callejón sin salida de pedirle un solo
 * campo: si solo entiende una parte, la repite completa.
 */
const REPETIR_EJEMPLO = [
  'Todavia no recibimos los dos datos de tu reserva. Por favor envianos la informacion en este formato:',
  'nombre de usuario: pepito123\ncodigo de producto: mouseX6',
  'El primero es tu nombre de usuario de TikTok y el segundo el codigo del producto que reservaste en el live.',
]

/**
 * Qué se responde cuando todavía no hay los dos datos de la reserva.
 *
 * @param vecesPreguntado Cuántas veces se le pidió ya, en esta conversación.
 * @param abreElFlujo Si este mensaje es el que abrió la conversación con
 *        "tiktok". El saludo largo solo tiene sentido ahí: repetirlo después
 *        hace que el comprador piense que el bot se reinició y no leyó nada.
 * @returns Los mensajes a enviar, en orden. Puede ser uno solo.
 */
export function mensajesParaPedirDatos(
  vecesPreguntado: number,
  abreElFlujo: boolean,
): string[] {
  // Primer aviso de una conversación recién abierta: saludo y formato.
  if (vecesPreguntado === 0 && abreElFlujo) return [...FORMATO_RESERVA]

  if (vecesPreguntado < 2) return [...REPETIR_EJEMPLO]

  // A partir del tercer aviso ya no se repite el ejemplo: insistir con el
  // mismo formato solo genera más ruido. Se pide la acción, y en el cuarto
  // aviso se ofrece una salida, porque ahí el bot ya no va a resolverlo solo.
  const mensajes = [
    `Te pedimos la informacion de tu reserva ${vecesPreguntado + 1} veces y no pudimos leerla. Por favor responde con los dos datos: tu nombre de usuario de TikTok y el codigo del producto.`,
  ]

  if (vecesPreguntado >= 3) {
    mensajes.push(
      'Si continuan los problemas, comunicate directamente con el vendedor del live para que te ayude a completar tu compra.',
    )
  }

  return mensajes
}

/** Se manda cuando venció el tiempo de pago y la reserva se perdió. */
export function mensajesReservaPerdida(): string[] {
  return [
    'Perdio la reserva debido a que no realizo el pago en el tiempo establecido.',
    'Si quieres volver a reservar, escribe: tiktok',
  ]
}
