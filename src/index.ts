import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import dotenv from 'dotenv'
import { Boom } from '@hapi/boom'
import { io as socketIO } from 'socket.io-client'
import {
  getActiveReservations,
  createOrder,
  generateQr,
  updateOrderStatus,
  getPendingOrderByWhatsapp,
  findPendingReservation,
  cancelReservation,
  uploadReceipt,
} from './api.service.js'
import {
  setBotStatus,
  getBotState,
  iniciarApiBot,
  borrarSesion,
  registrarPeticionConexion,
  SESSION_DIR,
} from './botApi.js'
import {
  esSolicitudDeCancelacion,
  limpiarUsername,
  mencionaTiktok,
  parseReservationMessage,
  quitarPalabraTiktok,
} from './parser.js'
import {
  mensajesParaPedirDatos,
  mensajesReservaPerdida,
} from './mensajes.js'

dotenv.config()

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080'
const BOT_API_PORT = Number(process.env.BOT_API_PORT) || 3111

/**
 * Cierre de sesión a pedido del vendedor.
 *
 * Además de revocar el vínculo con WhatsApp, borramos la sesión local: si no,
 * Baileys vuelve a conectarse con el mismo dispositivo sin pedir QR.
 *
 * Baileys no garantiza el orden entre `logout()` y el evento `close`, así que
 * marcamos el cierre como intencionado ANTES de llamar a logout. Sin esa
 * bandera, el evento `close` se interpreta como una caída y dispara la
 * reconexión automática, que compite con la conexión nueva y termina
 * consumiéndose entre sockets: el panel acaba siempre en "no hay QR".
 */
let cierreIntencionado = false

async function cerrarSesionWhatsApp(): Promise<void> {
  cierreIntencionado = true

  // Si hay una reconexión pendiente, la cancelamos: ahora manda el cierre.
  cancelarReconexion()

  const sock = globalSock ?? socketActivo
  globalSock = null
  socketActivo = null

  if (sock) {
    try {
      await sock.logout()
    } catch (error: any) {
      // Si el dispositivo ya no existe en el servidor, seguimos con el
      // borrado local que es lo que realmente importa aquí.
      console.error('No se pudo revocar el vinculo en el servidor:', error?.message)
    }
  }

  borrarSesion()
  console.log('Sesion de WhatsApp cerrada. Generando un QR nuevo...')

  // Damos un margen para que el socket anterior cierre del todo.
  setTimeout(() => {
    if (!cierreIntencionado) return
    conectar()
  }, 1500)
}

iniciarApiBot(BOT_API_PORT, {
  onLogout: cerrarSesionWhatsApp,
  onConnect: () => {
    // El panel pide un QR nuevo. Si ya hay un socket vivo, cerramos el
    // anterior antes de crear otro: dos sockets sobre la misma sesión en
    // disco se expulsan mutuamente y el QR se pierde en el proceso.
    reiniciarConexion()
  },
})

const firstNotificationMs = Number(process.env.FIRST_NOTIFICATION_MS) || 120000
const secondNotificationMs =
  Number(process.env.SECOND_NOTIFICATION_MS) || 240000
const reservationLostMs = Number(process.env.RESERVATION_LOST_MS) || 300000
const orderCancelMs = Number(process.env.ORDER_CANCEL_MS) || 360000

/**
 * Datos de una reserva a medio camino.
 *
 * El comprador puede mandar "nombre de usuario" y "codigo de producto" en
 * mensajes separados, que es lo habitual en un chat. Guardar lo que ya llegó
 * evita pedirle que lo escriba dos veces.
 */
const estadoEnCurso = new Map<
  string,
  { username: string; productCode: string }
>()

/**
 * Gestiona "Cancelar Reserva".
 *
 * El cliente no conoce el id de su reserva, solo el usuario con el que reservó,
 * así que primero se busca esa reserva pendiente y luego se cancela. Si no hay
 * ninguna, se le avisa con claridad: puede que ya haya pagado, y en ese caso
 * el problema es otro.
 */
async function cancelarReserva(sock: any, userJid: string): Promise<void> {
  const numero = userJid.split('@')[0]
  const pendiente = estadoEnCurso.get(numero)?.username

  try {
    // Prioridad: lo que el cliente ya escribió en esta conversación. Si no,
    // se busca por el número de WhatsApp, que es el dato con el que se creó
    // la orden.
    const reserva = pendiente ? await findPendingReservation(pendiente) : null

    if (reserva) {
      await cancelReservation(reserva.id)
      estadoEnCurso.delete(numero)
      cerrarConversacion(numero)

      await sock.sendMessage(userJid, {
        text:
          `Estimado cliente su reserva fue cancelada. ` +
          `Para adquirir algun producto, por favor ingrese al live.`,
      })

      console.log(`Reserva #${reserva.id} cancelada por el cliente ${numero}.`)
      return
    }

    // No hay reserva local, pero puede haber una orden pendiente creada desde
    // el chat. Se cancela para que el cliente no siga recibiendo avisos de
    // pago por algo que ya no quiere.
    const orden = await getPendingOrderByWhatsapp(numero)

    if (!orden) {
      await sock.sendMessage(userJid, {
        text:
          `Estimado cliente, no encontramos una reserva pendiente a su nombre. ` +
          `Si ya realizo el pago, por favor escribale al vendedor. ` +
          `Para adquirir algun producto, por favor ingrese al live.`,
      })
      return
    }

    await updateOrderStatus(orden.id, 'CANCELLED')
    estadoEnCurso.delete(numero)
    cerrarConversacion(numero)

    await sock.sendMessage(userJid, {
      text:
        `Estimado cliente su reserva fue cancelada. ` +
        `Para adquirir algun producto, por favor ingrese al live.`,
    })

    console.log(`Orden #${orden.id} cancelada por el cliente ${numero}.`)
  } catch (error: any) {
    console.error('Error cancelando la reserva:', error?.message || error)

    await sock.sendMessage(userJid, {
      text:
        `Ocurrio un problema al cancelar su reserva. ` +
        `Por favor intente de nuevo en unos minutos.`,
    })
  }
}

/**
 * Ventana durante la que el bot sigue respondiendo a una persona.
 *
 * Es lo que permite que el comprador escriba "nombre de usuario: pepito123"
 * después de haber dicho "tiktok", sin tener que repetir la palabra en cada
 * mensaje. media hora es suficiente para el flujo completo (reserva, QR, pago y
 * confirmación) y evita que el número quede respondiendo semanas después.
 */
const CONVERSACION_TTL_MS = 30 * 60 * 1000

/** numeroDeWhatsapp -> momento del último mensaje que mencionó TikTok. */
const ultimoTikTok = new Map<string, number>()

/**
 * Intentos fallidos de obtener los datos de la reserva, por persona.
 *
 * Lleva la cuenta para no repetir siempre el mismo mensaje. Se limpia en
 * cuanto llegan los datos, y también cuando se cancela la reserva.
 */
const intentosDatos = new Map<string, number>()

/**
 * ¿Seguimos en conversación con esta persona?
 *
 * Si la última vez que mencionó TikTok fue hace poco, el flujo sigue abierto y
 * el bot responde sin volver a exigir la palabra. Pasada la ventana, se olvida
 * y el próximo mensaje vuelve a necesitar "tiktok".
 */
function enConversacion(numero: string): boolean {
  const ultimo = ultimoTikTok.get(numero)

  if (!ultimo) return false

  if (Date.now() - ultimo > CONVERSACION_TTL_MS) {
    ultimoTikTok.delete(numero)
    return false
  }

  return true
}

/** Cierra el flujo con esta persona: vuelve a pedir "tiktok" para reabrirlo. */
function cerrarConversacion(numero: string): void {
  ultimoTikTok.delete(numero)
  intentosDatos.delete(numero)
  estadoEnCurso.delete(numero)
}

/**
 * Pide los datos de la reserva, escalando el mensaje según el intento.
 *
 * Se usa en los dos casos en que faltan datos: cuando no llegó nada legible y
 * cuando llegó solo uno de los dos campos. En ambos se recuerda SIEMPRE el
 * formato completo.
 *
 * Importante: nunca se pide un único campo. Si el comprador mandó solo el
 * usuario y el bot responde "ahora envia el codigo de producto", el comprador
 * contesta con el código, el bot lo toma como usuario nuevo y la reserva nunca
 * se encuentra: el flujo se queda dando vueltas sin llegar al QR. Recordar el
 * formato completo cada vez cierra ese bucle, porque el comprador reenvía los
 * dos datos juntos.
 *
 * El saludo completo se manda UNA sola vez: en el mensaje que abre el flujo con
 * "tiktok". Después, seguir saludando como si fuera la primera vez hace que el
 * comprador piense que el bot no leyó nada y termine escribiendo cualquier cosa.
 *
 * El mensaje también cambia con cada intento: repetir el mismo texto tres veces
 * seguidas hace pensar que el bot se trabó, y el comprador abandona la compra.
 */
async function pedirDatosDeReserva(
  sock: any,
  userJid: string,
  numero: string,
  abreElFlujo: boolean,
): Promise<void> {
  const vecesPreguntado = intentosDatos.get(numero) ?? 0
  intentosDatos.set(numero, vecesPreguntado + 1)

  for (const texto of mensajesParaPedirDatos(vecesPreguntado, abreElFlujo)) {
    await sock.sendMessage(userJid, { text: texto })
  }
}

/**
 * Traduce el error del backend a un mensaje que el comprador entienda.
 *
 * El backend ya devuelve un motivo concreto (referencia de otro pedido, monto
 * menor, fecha fuera de rango). Aquí solo se ajusta el cierre: no siempre tiene
 * sentido pedir una foto nueva cuando el problema es que el comprobante es de
 * otra compra.
 */
function mensajeErrorComprobante(motivo: string): string {
  const esReferenciaAjena =
    /corresponde al pedido|este pedido es de|menciona el producto/i.test(motivo)

  const cierre = esReferenciaAjena
    ? 'Revisa que hayas pagado el QR de TU compra y vuelve a enviarlo.'
    : 'Por favor verifica y envía la foto nuevamente, con la imagen completa y nitida.'

  return `❌ No pudimos validar tu comprobante:\n\n${motivo}\n\n${cierre}`
}

/**
 * Estado de la conexión con WhatsApp.
 *
 * Antes estas piezas vivían sueltas y se pisaban entre sí:
 *  - `conectandoEnCurso` evita abrir dos sockets a la vez.
 *  - `socketActivo` referencia el socket aunque todavía no esté autenticado
 *    (es decir, mientras espera el QR), que es justo el estado en el que el
 *    vendedor pide un QR nuevo.
 *  - `intentosReconexion` evita un bucle infinito de reconexiones cuando
 *    WhatsApp rechaza la sesión de forma persistente.
 */
let conectandoEnCurso = false
let socketActivo: any = null
let intentosReconexion = 0
const MAX_INTENTOS_RECONEXION = 5

/** Cierra el socket anterior y limpia sus listeners. */
function cerrarSocket(sock: any): void {
  if (!sock) return

  try {
    // Sin esto, el socket viejo sigue emitiendo eventos y sobreescribe el
    // estado del panel con su propio QR, ya obsoleto.
    sock.ev?.removeAllListeners?.('connection.update')
    sock.ev?.removeAllListeners?.('creds.update')
    sock.ev?.removeAllListeners?.('messages.upsert')
  } catch {
    // Un socket ya caído puede lanzar aquí; es esperado y no es grave.
  }

  try {
    sock.end?.(undefined)
  } catch {
    // Likewise: si ya estaba cerrado, no hay nada que hacer.
  }
}

/**
 * Reinicia la conexión desde cero.
 *
 * Es lo que llama el panel cuando el vendedor pide un QR nuevo y no aparece
 * ninguno. Cierra cualquier socket vivo (para que no compitan por la sesión
 * en disco) y abre uno limpio.
 */
function reiniciarConexion(): void {
  if (conectandoEnCurso) {
    console.log('Hay una conexion en curso; se espera a que termine.')
    return
  }

  console.log('Reiniciando la conexion para obtener un QR nuevo.')

  if (globalSock) {
    cerrarSocket(globalSock)
    globalSock = null
  }
  if (socketActivo) {
    cerrarSocket(socketActivo)
    socketActivo = null
  }

  // La sesión ya no sirve si estamos pidiendo un QR: sin esto Baileys
  // intentaría reconectar con el dispositivo anterior en vez de mostrar QR.
  borrarSesion()
  intentosReconexion = 0

  setBotStatus('INITIALIZING', { qr: null })
  marcarAperturaDeSesion()
  conectar()
}

/**
 * El panel pide un QR: aquí es donde se decide si hace falta una conexión
 * nueva o si el QR vigente todavía sirve.
 */
registrarPeticionConexion(() => {
  // Si ya tenemos un QR en pantalla, WhatsApp lo renueva solo. Reiniciar
  // obligaría al vendedor a escanear algo que ya tenía delante.
  if (getBotState().qr) return

  console.log('El panel solicito un QR.')
  reiniciarConexion()
})

async function connectToWhatsApp() {
  // Si ya hay una conexión en curso, no abrimos otra. Dos sockets escribiendo
  // sobre el mismo archivo de sesión se expulsan mutuamente, y el QR que
  // muestra el panel termina siendo el de un socket que ya no existe.
  if (conectandoEnCurso) {
    console.log('Conexion en curso, no se abre otra.')
    return
  }

  conectandoEnCurso = true

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
    const { version } = await fetchLatestBaileysVersion()
    const logger = pino({ level: 'silent' })

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      browser: ['LiveSales', 'Chrome', '10.0.0'],
      logger,
      getMessage: async () => undefined,
      shouldIgnoreJid: (jid) =>
        jid.endsWith('@g.us') || jid.endsWith('@broadcast'),
    })

    socketActivo = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr, receivedPendingNotifications } =
        update as typeof update & { receivedPendingNotifications?: unknown }

      if (qr) {
        console.log('CODIGO QR RECIBIDO:')
        qrcode.generate(qr, { small: true })
        // Hay un QR en pantalla, así que el ciclo de vinculación vuelve a ser
        // normal: cualquier cierre posterior debe reconectar con normalidad.
        cierreIntencionado = false
        // El panel del vendedor lo muestra para escanearlo desde el navegador.
        setBotStatus('QR_READY', { qr })
      }

      if (connection === 'connecting') {
        // No se pisa un QR que ya tenemos: WhatsApp lo renueva por su cuenta y
        // el panel sigue mostrando el último válido.
        if (!getBotState().qr) setBotStatus('INITIALIZING')
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
        const cerradoPorLogout = statusCode === DisconnectReason.loggedOut

        // Este socket ya no sirve, pero puede que haya otro en marcha.
        if (socketActivo === sock) socketActivo = null
        if (globalSock === sock) globalSock = null

        // El cierre intencionado ya tiene su propio flujo en
        // cerrarSesionWhatsApp: reconectar aquí competiría con ese QR.
        if (cierreIntencionado) {
          console.log('Cierre de sesion confirmado.')
          return
        }

        console.log('Conexion cerrada, reconectando:', !cerradoPorLogout)
        setBotStatus('DISCONNECTED')

        if (cerradoPorLogout) {
          // WhatsApp invalido la sesion por su cuenta: el vendedor desvinculo
          // el dispositivo desde el celular, o la credencial caduco.
          //
          // Reconectar con esas mismas credenciales volveria a recibir un 401
          // en bucle, dejando el bot sin QR y sin forma de recuperacion. La
          // unica salida es borrar la sesion y pedir un QR nuevo, que es
          // justo lo que hace el reinicio que sigue.
          console.log('WhatsApp invalido la sesion. Se pedira un QR nuevo.')
          borrarSesion()
          intentosReconexion = 0
          setBotStatus('INITIALIZING', { qr: null })
          conectar()
          return
        }

        intentosReconexion += 1

        if (intentosReconexion > MAX_INTENTOS_RECONEXION) {
          console.error(
            `Se alcanzo el limite de ${MAX_INTENTOS_RECONEXION} intentos de reconexion.`,
          )
          console.error(
            'La sesion guardada quedo invalida. Genera un QR nuevo desde el panel para volver a vincular.',
          )
          setBotStatus('DISCONNECTED', { qr: null })
          return
        }

        connectToWhatsApp()
      } else if (connection === 'open') {
        intentosReconexion = 0
        // La sesión volvió a estar viva: el cierre anterior era histórico.
        cierreIntencionado = false
        console.log('AUTENTICACION EXITOSA: Sesion iniciada.')
        console.log('CLIENTE LISTO: Bot escuchando mensajes.')
        // Asignar la conexión global para enviar mensajes inmediatos
        globalSock = sock
        setBotStatus('CONNECTED', { qr: null })
        // Procesar mensajes pendientes cuando el bot se conecta
        processPendingMessages(sock)
      }
    })

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return
    const msg = m.messages[0]

    if (!msg.key.remoteJid || msg.key.fromMe) return
    if (msg.key.remoteJid.endsWith('@g.us')) return

    const userJid = msg.key.remoteJid
    const realWhatsapp = userJid.split('@')[0]

    // Guardamos el JID real del contacto para poder responderle despues,
    // aunque la notificacion llegue desde el backend.
    registrarJid(realWhatsapp, userJid)

    const imageMessage =
      msg.message?.imageMessage ||
      msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage

    if (imageMessage) {
      const pendingOrder = await getPendingOrderByWhatsapp(realWhatsapp)

      if (!pendingOrder) {
        await sock.sendMessage(userJid, {
          text: 'No tienes ninguna orden pendiente de pago en este momento.',
        })
        return
      }

      await sock.sendMessage(userJid, {
        text: 'Recibimos tu comprobante. Estamos analizandolo, por favor espere unos segundos.',
      })

      try {
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger, reuploadRequest: sock.updateMediaMessage },
        )

        await uploadReceipt(pendingOrder.id, buffer as Buffer)

        await sock.sendMessage(userJid, {
          text: 'Comprobante recibido y analizado correctamente.\n\nTu pago esta siendo validado por el vendedor. Te notificaremos cuando se confirme.',
        })
      } catch (error: any) {
        await sock.sendMessage(userJid, {
          text: mensajeErrorComprobante(error.message),
        })
      }
      return
    }

    const incomingText =
      msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''

    if (!incomingText) return

    // Cancelar Reserva tiene prioridad: si el cliente está arrepentido, no
    // querés que el bot intente interpretarlo como datos de una reserva nueva.
    // Funciona sin decir "tiktok" porque el flujo ya está abierto.
    if (esSolicitudDeCancelacion(incomingText)) {
      if (!enConversacion(realWhatsapp)) {
        console.log(
          `Cancelacion sin flujo abierto de ${realWhatsapp}: se ignora.`,
        )
        return
      }

      await cancelarReserva(sock, userJid)
      return
    }

    // El flujo solo arranca si el mensaje menciona TikTok. Sin esto el bot
    // responde a cualquier saludo ("Hi", "Hola") y termina pidiendo datos de
    // reserva a quien solo está saludando.
    const flujoAbierto = enConversacion(realWhatsapp)
    const abreElFlujo = !flujoAbierto

    if (abreElFlujo) {
      if (!mencionaTiktok(incomingText)) {
        console.log(`Mensaje sin "tiktok" de ${realWhatsapp}: se ignora.`)
        return
      }

      ultimoTikTok.set(realWhatsapp, Date.now())
    } else {
      // Cada mensaje renueva la ventana: el comprador puede escribir despacio.
      ultimoTikTok.set(realWhatsapp, Date.now())
    }

    // "tiktok" es la palabra que abre el flujo, no un dato de la reserva. Si se
    // dejara en el texto, el parser leería "Tiktok" como nombre de usuario y
    // el bot respondería pidiendo solo el código de producto, cuando en
    // realidad el comprador aún no mandó ningún dato.
    const sinPalabraApertura = quitarPalabraTiktok(incomingText)

    const parsedData = parseReservationMessage(sinPalabraApertura)

    // Faltan datos: no llegó nada legible, o llegó solo uno de los dos campos.
    //
    // Se guarda lo que vino, pero NO se pide solo el campo que falta: se
    // recuerda el formato completo. Pedir un único campo hacía que el comprador
    // respondiera con un solo dato, el bot lo tomara como el otro campo, y la
    // reserva nunca se encontrara.
    //
    // El contador NO se reinicia aquí a propósito. Si se reiniciara al llegar
    // un dato suelto, el siguiente mensaje volvería al saludo inicial, que es
    // lo que hace pensar al comprador que el bot se reinició solo.
    const username = parsedData?.username ?? null
    const productCode = parsedData?.productCode ?? null

    if (!username || !productCode) {
      if (username || productCode) {
        estadoEnCurso.set(realWhatsapp, {
          username: username ?? estadoEnCurso.get(realWhatsapp)?.username ?? '',
          productCode:
            productCode ?? estadoEnCurso.get(realWhatsapp)?.productCode ?? '',
        })
      }

      await pedirDatosDeReserva(sock, userJid, realWhatsapp, abreElFlujo)
      return
    }

    // Llegaron los dos datos: el contador ya no aplica.
    intentosDatos.delete(realWhatsapp)

    try {
      const reservations = await getActiveReservations()

      const usernameLimpio = limpiarUsername(username)

      const found = reservations.find((r: any) => {
        const matchUser =
          r.tiktokUsername.trim().toLowerCase().replace(/^@/, '') ===
          usernameLimpio
        const matchCode =
          r.productCode.trim().toUpperCase() === productCode
        return matchUser && matchCode
      })

      // Puede que el usuario no coincida porque escribio mal el producto, o
      // al revés. Un mensaje por caso ayuda más que un "no se encontró".
      const usuarioExiste = reservations.some(
        (r: any) =>
          r.tiktokUsername.trim().toLowerCase().replace(/^@/, '') ===
          usernameLimpio,
      )

      if (!found) {
        if (!usuarioExiste) {
          await sock.sendMessage(userJid, {
            text: 'Debe ir al live de @LiveSales y realizar su reserva.',
          })
          return
        }

        await sock.sendMessage(userJid, {
          text: `El codigo de producto "${productCode}" no coincide con tu reserva. Revisa el codigo que aparecio en el live e intentalo de nuevo.`,
        })

        return
      }

      // La reserva quedó confirmada y ya no hace falta pedir "tiktok" otra vez:
      // el comprador está en la etapa de pago y comprobante. La ventana se
      // mantiene viva porque el pago y el OCR ocurren después de este mensaje.
      estadoEnCurso.delete(realWhatsapp)

      const priceNumber = parseFloat(found.product.price)

      const order = await createOrder({
        clientName: found.tiktokUsername,
        whatsapp: realWhatsapp,
        streamId: found.streamId,
        tiktokUsername: found.tiktokUsername,
        items: [
          {
            productId: found.productId,
            quantity: 1,
            price: priceNumber,
          },
        ],
      })

      const currentOrderId = order.id
      const qrData = await generateQr(currentOrderId)

      // Aviso de que la reserva quedó validada, antes de pedir el pago. Así el
      // cliente sabe que el bot confirmó sus datos y no está esperando otra
      // cosa.
      await sock.sendMessage(userJid, {
        text: 'Su reserva fue validada, por favor proceda con el pago del producto por favor.',
      })

      // El QR va en su propio mensaje: se envía la imagen sin texto y las
      // instrucciones aparte, para que el código no quede comprimido ni
      // corriendo detrás del pie de foto.
      await sock.sendMessage(userJid, {
        image: { url: qrData.qrImageUrl },
      })

      await sock.sendMessage(userJid, {
        text:
          'Por favor realice el pago de su producto con el siguiente QR o ingresando al enlace de pago directo:\n' +
          `${qrData.qrUrl}\n\n` +
          'NOTA: Tiene 5 minutos desde este momento para realizar su pago, caso contrario perdera la reserva.\n\n' +
          'Una vez realizado el pago por favor envie la fotografía del comprobante. En caso de no poder continuar, escriba: Cancelar Reserva.',
      })

      setTimeout(async () => {
        try {
          const current = await getPendingOrderByWhatsapp(realWhatsapp)
          if (
            current &&
            current.id === currentOrderId &&
            current.status === 'PENDING'
          ) {
            await sock.sendMessage(userJid, {
              text: 'Atencion le quedan 3 minutos para realizar el pago o perdera la reserva',
            })
          }
        } catch (err) {}
      }, firstNotificationMs)

      setTimeout(async () => {
        try {
          const current = await getPendingOrderByWhatsapp(realWhatsapp)
          if (
            current &&
            current.id === currentOrderId &&
            current.status === 'PENDING'
          ) {
            await sock.sendMessage(userJid, {
              text: 'Atencion le queda 1 minuto para realizar el pago o perdera la reserva',
            })
          }
        } catch (err) {}
      }, secondNotificationMs)

      setTimeout(async () => {
        try {
          const current = await getPendingOrderByWhatsapp(realWhatsapp)
          if (
            current &&
            current.id === currentOrderId &&
            current.status === 'PENDING'
          ) {
            for (const texto of mensajesReservaPerdida()) {
              await sock.sendMessage(userJid, { text: texto })
            }

            // La reserva se perdio, asi que el ciclo con este comprador
            // termina aqui. El bot queda mudo y solo vuelve a responder si
            // escribe "tiktok", que es la palabra con la que se abre el flujo.
            //
            // Si se dejara abierto, el comprador responderia cualquier cosa
            // ("hola", "ya pague") y el bot le pediria los datos de una reserva
            // que ya no existe, sin llegar nunca a nada.
            cerrarConversacion(realWhatsapp)          }
        } catch (err) {}
      }, reservationLostMs)

      setTimeout(async () => {
        try {
          const current = await getPendingOrderByWhatsapp(realWhatsapp)
          // Solo se cancela si la orden sigue PENDING. Si el cliente ya envio
          // el comprobante la orden esta IN_REVIEW y debe respetarse.
          if (
            current &&
            current.id === currentOrderId &&
            current.status === 'PENDING'
          ) {
            await updateOrderStatus(currentOrderId, 'CANCELLED')
          }
        } catch (err) {}
      }, orderCancelMs)
    } catch (error) {
      await sock.sendMessage(userJid, {
        text: 'Ocurrio un problema al procesar su orden. Por favor intenta mas tarde.',
      })
    }
  })
  } finally {
    // Se libera siempre, incluso si falla la apertura: si el flag quedara en
    // true, el bot quedaría sin poder reconectarse nunca más.
    conectandoEnCurso = false
  }
}

/** Alias corto para no shadowear el nombre histórico de la función. */
function conectar() {
  void connectToWhatsApp()
}

/** Cancela una reconexión pendiente. */
function cancelarReconexion(): void {
  // La reconexión se dispara de inmediato al detectar el cierre, así que
  // basta con el flag: si ya hay una en vuelo, el guard la ignora.
  intentosReconexion = 0
}

/**
 * Sincroniza la bandera de cierre intencionado con la sesión real.
 *
 * Si el vendedor vuelve a conectar desde el panel tras cerrar sesión, el
 * proceso sigue en marcha y esa bandera debe volver a false; si no, el
 * siguiente `close` se interpretaría como parte del cierre manual y el bot
 * se quedaría sin reconectar nunca más.
 */
function marcarAperturaDeSesion(): void {
  cierreIntencionado = false
}

// Variable global para almacenar la conexión del bot
let globalSock: any = null

/**
 * Mapa: numeroDeWhatsapp -> JID real del contacto.
 *
 * Por que existe: WhatsApp no siempre entrega los mensajes usando el formato
 * `<numero>@s.whatsapp.net`. Los contactos pueden llegar con otros dominios,
 * como `@lid` (identidad vinculada) o `@c.us` (formato legado).
 *
 * Si reconstruimos el JID a partir del numero guardado en la base de datos,
 * WhatsApp acepta el envio sin error (status PENDING) pero NUNCA lo entrega,
 * y el cliente nunca recibe nada.
 *
 * Por eso guardamos el JID exacto con el que el bot ya se comunico con cada
 * contacto y lo reutilizamos para las notificaciones posteriores.
 */
const jidsReales = new Map<string, string>()

function registrarJid(numero: string, jid: string): void {
  jidsReales.set(numero, jid)
}

function resolverJid(numero: string): string {
  return jidsReales.get(numero) ?? `${numero}@s.whatsapp.net`
}

// Conectar al Socket.IO del backend para escuchar pagos validados
async function connectToBackendSocket() {
  // El backend exige un JWT valido para aceptar conexiones de socket.
  let authToken: string | null = null
  try {
    const loginResponse = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: process.env.API_USERNAME || 'Admin',
        password: process.env.API_PASSWORD || 'Admin',
      }),
    })
    const loginData = await loginResponse.json()
    authToken = loginData.data?.token ?? null
  } catch (error) {
    console.error('No se pudo autenticar contra el backend:', error)
  }

  const socket = socketIO(BACKEND_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    auth: { token: authToken },
  })

  socket.on('connect', () => {
    console.log('Bot conectado al backend.')
  })

  socket.on('disconnect', (reason) => {
    console.log('Bot desconectado del backend:', reason)
  })

  socket.on('connect_error', (error) => {
    console.error('Error de conexion con el backend:', error.message)
  })

  /**
   * Notifica al cliente que el vendedor aprobo su pago.
   *
   * El JID se resuelve desde el mapa de JIDs reales: no se puede reconstruir
   * con `<numero>@s.whatsapp.net` porque esos destinatarios nunca reciben.
   */
  socket.on(
    'pago:validado',
    async (data: {
      pedidoId: number
      whatsapp: string
      nombreCliente: string
      tiktokUsername: string
    }) => {
      const numero = String(data.whatsapp || '').replace(/\D/g, '')
      const nombreUsuario = (
        data.tiktokUsername ||
        data.nombreCliente ||
        'cliente'
      ).replace(/^@/, '')

      const jid = resolverJid(numero)

      // Confirmación en dos mensajes: el segundo es la dirección de la tienda.
      // Ir en uno solo lo dejaba buried en un párrafo con la confirmación.
      const confirmacion =
        `¡Buenas noticias ${nombreUsuario}!\n\n` +
        `Tu pago ha sido verificado por el vendedor.\n` +
        `Tu pedido #${data.pedidoId} ha sido confirmado exitosamente.\n\n` +
        `¡Gracias por tu compra!`

      const entrega =
        `Puedes pasar a recoger tu pedido en nuestra tienda ubicada al frente del correo, ` +
        `en el edificio Portales oficina #16.`

      if (!globalSock) {
        console.warn('Sin sesion de WhatsApp: confirmacion encolada.')
        pendingMessages.push({ jid, message: confirmacion })
        pendingMessages.push({ jid, message: entrega })
        return
      }

      try {
        await globalSock.sendMessage(jid, { text: confirmacion })
        await globalSock.sendMessage(jid, { text: entrega })
        console.log(`Pago del pedido #${data.pedidoId} confirmado con el cliente.`)
      } catch (error: any) {
        console.error(
          `No se pudo confirmar el pedido #${data.pedidoId}:`,
          error?.message || error,
        )
        pendingMessages.push({ jid, message: confirmacion })
        pendingMessages.push({ jid, message: entrega })
      }
    },
  )

  /**
   * El vendedor rechazó el comprobante.
   *
   * Se pide al cliente que verifique porque lo más probable es que el monto no
   * se haya acreditado todavía, o que haya enviado el comprobante equivocado.
   */
  socket.on(
    'pago:rechazado',
    async (data: { pedidoId: number; whatsapp: string }) => {
      const numero = String(data.whatsapp || '').replace(/\D/g, '')
      const jid = resolverJid(numero)

      const mensaje =
        `Su comprobante del pedido #${data.pedidoId} no pudo ser validado. ` +
        `Por favor verifique su pago, ya que no se recibio el pago en nuestra cuenta. ` +
        `Si realizo la transferencia, esperemos unos minutos y envie el comprobante nuevamente.`

      if (!globalSock) {
        pendingMessages.push({ jid, message: mensaje })
        return
      }

      try {
        await globalSock.sendMessage(jid, { text: mensaje })
        console.log(
          `Rechazo del pedido #${data.pedidoId} comunicado al cliente.`,
        )
      } catch (error: any) {
        console.error(
          `No se pudo comunicar el rechazo del pedido #${data.pedidoId}:`,
          error?.message || error,
        )
        pendingMessages.push({ jid, message: mensaje })
      }
    },
  )

  return socket
}

// Cola de mensajes pendientes para enviar cuando el bot este conectado
const pendingMessages: Array<{ jid: string; message: string }> = []

async function processPendingMessages(sock: any) {
  while (pendingMessages.length > 0) {
    const msg = pendingMessages.shift()
    if (!msg) continue

    try {
      await sock.sendMessage(msg.jid, { text: msg.message })
    } catch (error: any) {
      console.error(
        'No se pudo enviar un mensaje pendiente:',
        error?.message || error,
      )
    }
  }
}

/**
 * Detecta la sesión desincronizada y pide un QR nuevo.
 *
 * libsignal lanza `MessageCounterError` cuando la sesión guardada ya no puede
 * descifrar lo que WhatsApp reenvía. Suele pasar con mensajes viejos en cola al
 * arrancar, o si el número se revitalizó desde otro equipo.
 *
 * Estos errores no son recuperables reintentando: la misma sesión fallaría
 * igual una y otra vez. La única salida es borrar las credenciales y volver a
 * vincular.
 *
 * PERO solo se actúa si el bot NO está funcionando. Si la sesión está
 * conectada, un mensaje viejo que no se puede descifrar es inofensivo: se
 * descarta y el bot sigue operando. Borrar ahí una sesión sana obligaría al
 * vendedor a escanear un QR sin motivo, que es justo lo que hay que evitar.
 */
let reintentandoSesion = false
let erroresDescifrado = 0

process.on('unhandledRejection', (motivo: any) => {
  const mensaje = String(motivo?.message || motivo || '')

  const esSesionDesincronizada =
    /MessageCounterError|Key used already|SessionCipher|decrypt/i.test(mensaje)

  if (!esSesionDesincronizada) {
    // Este handler sustituye al de Node, así que los demás rechazos
    // seguimos teniendo que reportarlos: si no, se perderían en silencio.
    console.error('Rechazo no controlado:', motivo)
    return
  }

  erroresDescifrado += 1

  if (getBotState().status === 'CONNECTED') {
    // La sesión vive. El mensaje corrupto se descarta y seguimos.
    console.warn(
      `No se pudo descifrar un mensaje antiguo (${erroresDescifrado} en total). ` +
        'La sesion sigue conectada, no hace falta nada.',
    )
    return
  }

  console.error('La sesion de WhatsApp quedo desincronizada:', mensaje)

  if (reintentandoSesion) {
    console.error(
      'Ya se intento recuperar la sesion una vez. Si persiste, reinicia el bot.',
    )
    return
  }

  reintentandoSesion = true
  console.error('Se borrara la sesion y se pedira un QR nuevo para vincular.')

  borrarSesion()
  reiniciarConexion()
})

connectToBackendSocket()

connectToWhatsApp()
