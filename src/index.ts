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
  uploadReceipt,
} from './api.service.js'
import {
  setBotStatus,
  iniciarApiBot,
  borrarSesion,
  type BotStatus,
} from './botApi.js'

dotenv.config()

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080'
const BOT_API_PORT = Number(process.env.BOT_API_PORT) || 3111

/**
 * El panel del vendedor puede cerrar la sesión de WhatsApp. Además de revocar
 * el vínculo, borramos la sesión local: si no, Baileys volvería a conectarse
 * con el mismo dispositivo sin pedir QR.
 *
 * Al terminar levantamos una conexión nueva para que el panel reciba un QR
 * fresco y el vendedor pueda vincular otro número sin reiniciar el proceso.
 */
async function cerrarSesionWhatsApp(): Promise<void> {
  const sock = globalSock
  globalSock = null

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
    connectToWhatsApp()
  }, 1500)
}

iniciarApiBot(BOT_API_PORT, {
  onLogout: cerrarSesionWhatsApp,
  onConnect: () => {
    // Si el panel pide conectar y ya hay un socket vivo, no hacemos nada.
    if (globalSock) return
    connectToWhatsApp()
  },
})

const firstNotificationMs = Number(process.env.FIRST_NOTIFICATION_MS) || 120000
const secondNotificationMs =
  Number(process.env.SECOND_NOTIFICATION_MS) || 240000
const reservationLostMs = Number(process.env.RESERVATION_LOST_MS) || 300000
const orderCancelMs = Number(process.env.ORDER_CANCEL_MS) || 360000

function parseReservationMessage(
  text: string,
): { username: string; productCode: string } | null {
  const clean = text.trim()
  const userRegex = /(?:nombre\s*de\s*usuario|usuario|user)\s*:\s*([^\n\r]+)/i
  const productRegex =
    /(?:codigo\s*de\s*producto|producto|codigo)\s*:\s*([^\n\r]+)/i

  const userMatch = clean.match(userRegex)
  const productMatch = clean.match(productRegex)

  if (userMatch && productMatch) {
    return {
      username: userMatch[1].trim().toLowerCase().replace(/^@/, ''),
      productCode: productMatch[1].trim().toUpperCase(),
    }
  }

  return null
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

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
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

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } =
      update as typeof update & { receivedPendingNotifications?: unknown }

    if (qr) {
      console.log('CODIGO QR RECIBIDO:')
      qrcode.generate(qr, { small: true })
      // El panel del vendedor lo muestra para escanearlo desde el navegador.
      setBotStatus('QR_READY', { qr })
    }

    if (connection === 'connecting') {
      setBotStatus('INITIALIZING')
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const cerradoPorLogout = statusCode === DisconnectReason.loggedOut

      console.log('Conexion cerrada, reconectando:', !cerradoPorLogout)
      setBotStatus('DISCONNECTED')

      // Si el vendedor cerró sesión desde el panel, no reconectamos:
      // debe volver a escanear un QR nuevo.
      if (cerradoPorLogout) {
        globalSock = null
        console.log('Sesion cerrada. Vuelve a escanear el QR para conectar.')
        return
      }

      connectToWhatsApp()
    } else if (connection === 'open') {
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
        text: '⏳ Recibimos tu comprobante. Estamos analizándolo con Inteligencia Artificial, por favor espera unos segundos...',
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
          text: '✅ Comprobante recibido y analizado correctamente.\n\nTu pago está siendo validado por el vendedor. Te notificaremos cuando se confirme. 🙏',
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

    const parsedData = parseReservationMessage(incomingText)

    if (!parsedData) {
      await sock.sendMessage(userJid, {
        text: 'Gracias por comunicarte con Tienda LiveSales, Si realizaste una reserva por tiktok, por favor envianos la siguiente informacion en este formato:\n\nnombre de usuario:\ncodigo de producto:',
      })
      return
    }

    try {
      const reservations = await getActiveReservations()

      const found = reservations.find((r: any) => {
        const matchUser =
          r.tiktokUsername.trim().toLowerCase().replace(/^@/, '') ===
          parsedData.username
        const matchCode =
          r.productCode.trim().toUpperCase() === parsedData.productCode
        return matchUser && matchCode
      })

      if (!found) {
        await sock.sendMessage(userJid, {
          text: 'Debe ir al live de @LiveSales y realizar su reserva.',
        })
        return
      }

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

      const paymentInstructions =
        'Por favor realice el pago de su producto con el siguiente QR o ingresando al enlace de pago directo:\n' +
        `${qrData.qrUrl}\n\n` +
        '*NOTA: Tiene 5 minutos desde este momento para realizar su pago, caso contrario perdera la reserva.*\n\n' +
        'Una vez realizado el pago por favor envie la fotografía del comprobante. En caso de no poder continuar, escriba: Cancelar Reserva.'

      await sock.sendMessage(userJid, {
        image: { url: qrData.qrImageUrl },
        caption: paymentInstructions,
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
            await sock.sendMessage(userJid, {
              text: 'Perdio la reserva debido a que no realizo el pago en el tiempo establecido.',
            })
          }
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
      const mensaje =
        `✅ ¡Buenas noticias ${nombreUsuario}!\n\n` +
        `Tu pago ha sido verificado por el vendedor.\n` +
        `Tu pedido #${data.pedidoId} ha sido confirmado exitosamente.\n\n` +
        `¡Gracias por tu compra! 🎉`

      if (!globalSock) {
        console.warn('Sin sesion de WhatsApp: confirmacion encolada.')
        pendingMessages.push({ jid, message: mensaje })
        return
      }

      try {
        await globalSock.sendMessage(jid, { text: mensaje })
        console.log(`Pago del pedido #${data.pedidoId} confirmado con el cliente.`)
      } catch (error: any) {
        console.error(
          `No se pudo confirmar el pedido #${data.pedidoId}:`,
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

connectToBackendSocket()

connectToWhatsApp()
