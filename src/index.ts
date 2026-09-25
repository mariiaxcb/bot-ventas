import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import dotenv from 'dotenv'
import { Boom } from '@hapi/boom'
import {
  getActiveReservations,
  createOrder,
  generateQr,
  updateOrderStatus,
} from './api.service.js'

dotenv.config()

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
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('CODIGO QR RECIBIDO:')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !==
        DisconnectReason.loggedOut
      console.log('Conexion cerrada, reconectando:', shouldReconnect)
      if (shouldReconnect) {
        connectToWhatsApp()
      }
    } else if (connection === 'open') {
      console.log('AUTENTICACION EXITOSA: Sesion iniciada.')
      console.log('CLIENTE LISTO: Bot escuchando mensajes.')
    }
  })

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return
    const msg = m.messages[0]

    if (!msg.key.remoteJid || msg.key.fromMe) return
    if (msg.key.remoteJid.endsWith('@g.us')) return

    const userJid = msg.key.remoteJid
    const incomingText =
      msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''

    if (!incomingText) return

    console.log('--- MENSAJE DE CHAT RECIBIDO ---')
    console.log('De:', userJid)
    console.log('Texto:', incomingText)

    const parsedData = parseReservationMessage(incomingText)

    if (!parsedData) {
      console.log('Mensaje no coincide con el formato. Enviando instrucciones.')
      await sock.sendMessage(userJid, {
        text: 'Gracias por comunicarte con Tienda LiveSales, Si realizaste una reserva por tiktok, por favor envianos la siguiente informacion en este formato:\n\nnombre de usuario:\ncodigo de producto:',
      })
      return
    }

    console.log('Datos extraidos con exito:')
    console.log('Usuario:', parsedData.username)
    console.log('Codigo de producto:', parsedData.productCode)

    try {
      const reservations = await getActiveReservations()

      const found = reservations.find((r) => {
        const matchUser =
          r.tiktokUsername.trim().toLowerCase().replace(/^@/, '') ===
          parsedData.username
        const matchCode =
          r.productCode.trim().toUpperCase() === parsedData.productCode
        return matchUser && matchCode
      })

      if (!found) {
        console.log('Reserva no encontrada en la lista activa.')
        await sock.sendMessage(userJid, {
          text: 'Debe ir al live de @LiveSales y realizar su reserva.',
        })
        return
      }

      console.log(`Reserva verificada exitosamente: ID ${found.id}`)

      const realWhatsapp = userJid.split('@')[0]
      const priceNumber = parseFloat(found.product.price)

      console.log(
        `Procediendo a crear orden para cliente: ${found.tiktokUsername}, Telefono: ${realWhatsapp}`,
      )

      const order = await createOrder({
        clientName: found.tiktokUsername,
        whatsapp: realWhatsapp,
        streamId: found.streamId,
        items: [
          {
            productId: found.productId,
            quantity: 1,
            price: priceNumber,
          },
        ],
      })

      const currentOrderId = order.id
      console.log(
        `Orden #${currentOrderId} creada. Solicitando QR a Canela Bank y Cloudinary...`,
      )

      const qrData = await generateQr(currentOrderId)

      const paymentInstructions =
        'Por favor realice el pago de su producto con el siguiente QR o ingresando al enlace de pago directo:\n' +
        `${qrData.qrUrl}\n\n` +
        '*NOTA: Tiene 5 minutos desde este momento para realizar su pago, caso contrario perdera la reserva.*\n\n' +
        'Una vez realizado el pago por favor envie el comprobante de pago, en caso de no poder continuar con la compra, por favor escriba: Cancelar Reserva.'

      await sock.sendMessage(userJid, {
        image: { url: qrData.qrImageUrl },
        caption: paymentInstructions,
      })

      console.log(`Imagen y texto enviados exitosamente a ${userJid}`)

      setTimeout(async () => {
        try {
          await sock.sendMessage(userJid, {
            text: 'Atencion le quedan 3 minutos para realizar el pago o perdera la reserva',
          })
        } catch (err) {
          console.error('Error enviando primera notificacion:', err)
        }
      }, firstNotificationMs)

      setTimeout(async () => {
        try {
          await sock.sendMessage(userJid, {
            text: 'Atencion le queda 1 minuto para realizar el pago o perdera la reserva',
          })
        } catch (err) {
          console.error('Error enviando segunda notificacion:', err)
        }
      }, secondNotificationMs)

      setTimeout(async () => {
        try {
          await sock.sendMessage(userJid, {
            text: 'Perdio la reserva debido a que no realizo el pago en el tiempo establecido.',
          })
        } catch (err) {
          console.error(
            'Error enviando notificacion de perdida de reserva:',
            err,
          )
        }
      }, reservationLostMs)

      setTimeout(async () => {
        try {
          console.log(
            `Tiempo limite alcanzado. Cancelando orden #${currentOrderId} en la API...`,
          )
          await updateOrderStatus(currentOrderId, 'CANCELLED')
          console.log(
            `Orden #${currentOrderId} cancelada exitosamente en la API.`,
          )
        } catch (err) {
          console.error(
            `Error cancelando la orden #${currentOrderId} en la API:`,
            err,
          )
        }
      }, orderCancelMs)
    } catch (error) {
      console.error('Error procesando el flujo de reserva y orden:', error)
      await sock.sendMessage(userJid, {
        text: 'Ocurrio un problema al procesar su orden. Por favor intenta mas tarde.',
      })
    }
  })
}

connectToWhatsApp()
