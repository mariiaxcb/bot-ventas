/**
 * Lectura de los mensajes del comprador.
 *
 * Vive aparte de `index.ts` por dos motivos:
 *
 *  1. Es lógica pura, sin sockets ni llamadas HTTP: se puede probar sola.
 *  2. El parser es la parte que más falla. Si el tester copia el código a mano
 *     para comprobarlo, termina probando una copia y no lo que se despliega.
 *     Los tests de `parser.test.ts` importan este mismo archivo.
 */

/** Los dos datos que identifican una reserva. Cualquiera puede faltar. */
export type DatosReserva = {
  username: string | null
  productCode: string | null
}

/** Normaliza texto para buscar palabras ignorando acentos y mayúsculas. */
export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

/**
 * Convierte el texto en algo presentable como nombre de usuario.
 *
 * Se quita el @ y se pasan a minúsculas porque así es como el backend guarda
 * la reserva; sin esto, "pepito123" y "@Pepito123" no casarían.
 */
export function limpiarUsername(valor: string): string {
  return valor.trim().replace(/^@/, '').toLowerCase()
}

/** ¿El mensaje menciona TikTok? Es la palabra que abre el flujo. */
export function mencionaTiktok(text: string): boolean {
  return normalizar(text).includes('tiktok')
}

/**
 * Quita las apariciones sueltas de "tiktok" del mensaje.
 *
 * La palabra abre el flujo pero no es un dato de la reserva. Sin quitarla, un
 * mensaje que solo dice "Tiktok" se interpreta como nombre de usuario y el bot
 * termina pidiendo únicamente el código de producto.
 *
 * Solo se quitan palabras completas: en un usuario como "tiktok_shop" el
 * "tiktok" forma parte del nombre y debe quedarse.
 *
 * Los saltos de línea se respetan. Aplanarlos rompía el formato que el propio
 * bot pide: "nombre de usuario: pepito123\ncodigo de producto: mouseX6" se
 * leía como una sola línea y el nombre de usuario quedaba con el código
 * pegado ("pepito123 codigo de producto: mouseX6"), con lo que la reserva
 * jamás se encontraba.
 */
export function quitarPalabraTiktok(text: string): string {
  return text
    .replace(/\btiktok\b/gi, ' ')
    .split(/\r?\n/)
    .map((linea) => linea.replace(/[^\S\r\n]+/g, ' ').trim())
    .join('\n')
    .trim()
}

/**
 * Detecta si el cliente quiere cancelar su reserva.
 *
 * Acepta varias formas porque el comprador escribe como le sale: "Cancelar
 * Reserva", "cancelar reserva", "cancelar" o "ya no quiero el producto".
 */
export function esSolicitudDeCancelacion(text: string): boolean {
  const limpio = normalizar(text)
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (limpio.includes('cancelar reserva')) return true
  if (limpio === 'cancelar' || limpio === 'cancelar por favor') return true
  if (limpio.includes('ya no quiero')) return true

  return false
}

/**
 * Cualquier etiqueta de campo ("nombre de usuario:", "codigo de producto:").
 *
 * Se usa para cortar el valor de un campo cuando el comprador escribe el
 * formato entero en una sola línea: "nombre de usuario: pepito123 codigo de
 * producto: mouseX6". Sin el corte, el nombre de usuario se tragaba el código
 * y el bot buscaba una reserva llamada "pepito123 codigo de producto: mouseX6".
 *
 * También cubre el formato vacío: "nombre de usuario:\ncodigo de producto:".
 * El valor del usuario no es "codigo de producto:", es la etiqueta siguiente.
 */
const RE_ETIQUETA_ENCONTRADA =
  /(?:nombre\s*de\s*usuario|usuario|user|codigo\s*de\s*producto|producto|codigo)[ \t]*:/i

/**
 * Saca el valor de un campo del texto, o `null` si no hay ninguno real.
 *
 * Corta en la siguiente etiqueta, así que funciona tanto si el formato viene
 * en dos líneas como si viene todo en una.
 */
function valorDelCampo(
  texto: string,
  regex: RegExp,
): string | null {
  const match = texto.match(regex)
  if (!match) return null

  const bruto = match[1]

  // Al valor le sobra todo lo que venga después de otra etiqueta, que ya es el
  // campo siguiente y no parte de este.
  const corte = bruto.match(RE_ETIQUETA_ENCONTRADA)
  const valor = (corte?.index === undefined ? bruto : bruto.slice(0, corte.index))
    .trim()

  if (!valor) return null

  return valor
}

/** Un token con forma de dato: una sola palabra, sin espacios. */
const RE_TOKEN_DATO = /^[A-Za-z0-9@][A-Za-z0-9._@-]{1,49}$/

/**
 * Cuántas palabras se revisan como máximo en un mensaje sin etiquetas.
 *
 * Tres alcanza para "Hola pepito123 mouseX6". Con más palabras ya no es una
 * lista de datos sino una frase, y buscar un par dentro de ella produciría
 * combinaciones inventadas.
 */
const MAX_PALABRAS = 3

/**
 * ¿El token parece un usuario de TikTok de verdad?
 *
 * Esta es la regla que decide si un mensaje suelto es una persona saludando o
 * los datos de una reserva, y es estructural a propósito: un usuario de TikTok
 * casi siempre lleva un número o una línea baja ("pepito123", "rashad_barra",
 * "mio123"), mientras que un saludo no ("Bola", "Jola", "Hola", "qwerty").
 *
 * Se usó antes una lista de palabras prohibidas, y fallaba: cada palabra nueva
 * que se le ocurre a un comprador obliga a agregarla, y el problema reaparece
 * con la siguiente. Con esta regla no hay nada que mantener.
 *
 * Solo se exige en el usuario, que es donde el error duele: si se tomara
 * "hola" como nombre de usuario, el bot buscaría una reserva de "hola".
 */
function pareceNombreDeUsuario(token: string): boolean {
  if (!RE_TOKEN_DATO.test(token)) return false

  return /\d/.test(token) || token.includes('_')
}

/**
 * Interpreta un mensaje escrito sin etiquetas.
 *
 * Se busca el primer token que parece un usuario; el token siguiente es el
 * código. Así "Hola pepito123 mouseX6" funciona sin listar saludos: la palabra
 * de cortesía se ignora por no parecer un usuario, no por estar en una lista.
 *
 * Si no hay usuario, o si no viene un token detrás, no hay datos. Un token
 * suelto NO se acepta nunca, aunque parezca un usuario: "pepito123" y "mouseX6"
 * por separado son indistinguibles entre sí, y adivinar convertiría medio dato
 * en una búsqueda de reserva que no existe.
 *
 * Cualquier otra cosa devuelve `null`, y quien llama responde con el formato
 * completo. Es mejor pedir los datos otra vez que adivinar.
 */
function parsearDatosSueltos(clean: string): DatosReserva | null {
  const palabras = clean
    .split(/[\s,;|]+/)
    .map((p) => p.trim())
    .filter(Boolean)

  if (palabras.length < 2 || palabras.length > MAX_PALABRAS) return null

  const indiceUsuario = palabras.findIndex((p) => pareceNombreDeUsuario(p))

  if (indiceUsuario === -1) return null

  const codigo = palabras[indiceUsuario + 1]

  if (!codigo || !RE_TOKEN_DATO.test(codigo)) return null

  return {
    username: limpiarUsername(palabras[indiceUsuario]),
    productCode: codigo.toUpperCase(),
  }
}

/**
 * Parsea los datos de la reserva.
 *
 * Acepta los dos campos juntos o por separado: en WhatsApp es habitual que el
 * comprador escriba "nombre de usuario: pepito123", espere el QR y luego
 * mande "codigo de producto: mouseX6" al ver que el bot pide los dos. Rechazar
 * el segundo mensaje dejaria al cliente sin poder comprar.
 *
 * Devuelve `null` cuando no hay nada legible, que es la señal para volver a
 * pedir el formato completo.
 */
export function parseReservationMessage(text: string): DatosReserva | null {
  const clean = text.trim()

  // El separador tras los dos puntos NO puede cruzar el salto de línea: si
  // cruce, "nombre de usuario:\ncodigo de producto:" se leería como si el
  // nombre de usuario fuera "codigo de producto".
  const userRegex =
    /(?:nombre\s*de\s*usuario|usuario|user)[ \t]*:[ \t]*([^\n\r]*)/i
  const productRegex =
    /(?:codigo\s*de\s*producto|producto|codigo)[ \t]*:[ \t]*([^\n\r]*)/i

  const tieneEtiqueta =
    /(?:nombre\s*de\s*usuario|usuario|user|codigo\s*de\s*producto|producto|codigo)[ \t]*:/i.test(
      clean,
    )

  if (!tieneEtiqueta) return parsearDatosSueltos(clean)

  const usernameCrudo = valorDelCampo(clean, userRegex)
  const productCodeCrudo = valorDelCampo(clean, productRegex)

  // Etiquetas copiadas pero sin valores: el comprador no mandó nada aún.
  if (!usernameCrudo && !productCodeCrudo) return null

  return {
    username: usernameCrudo
      ? limpiarUsername(usernameCrudo)
      : null,
    productCode: productCodeCrudo ? productCodeCrudo.toUpperCase() : null,
  }
}
