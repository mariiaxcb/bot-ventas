import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import dotenv from 'dotenv'
import { Boom } from '@hapi/boom'
import {
  getActiveReservations,
  createOrder,
  generateQr,
} from './api.service.js'

dotenv.config()

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

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['LiveSales', 'Chrome', '10.0.0'],
    logger: pino({ level: 'silent' })
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('CODIGO QR RECIBIDO:')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
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

    const incomingText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
    
    if (!incomingText) return

    console.log('--- MENSAJE DE CHAT RECIBIDO ---')
    console.log('De:', msg.key.remoteJid)
    console.log('Texto:', incomingText)

    const parsedData = parseReservationMessage(incomingText)

    if (!parsedData) {
      console.log('Mensaje no coincide con el formato. Enviando instrucciones.')
      await sock.sendMessage(msg.key.remoteJid, { 
        text: 'Gracias por comunicarte con Tienda LiveSales, Si realizaste una reserva por tiktok, por favor envianos la siguiente informacion en este formato:\n\nnombre de usuario:\ncodigo de producto:' 
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
        await sock.sendMessage(msg.key.remoteJid, { 
          text: 'Debe ir al live de @LiveSales y realizar su reserva.' 
        })
        return
      }

      console.log(`Reserva verificada exitosamente: ID ${found.id}`)

      const realWhatsapp = msg.key.remoteJid.split('@')[0]
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

      console.log(`Orden #${order.id} creada. Solicitando QR a Canela Bank y Cloudinary...`)

      const qrData = await generateQr(order.id)

      const paymentInstructions =
        'Por favor realice el pago de su producto con el siguiente QR o ingresando al enlace de pago directo:\n' +
        `${qrData.qrUrl}\n\n` +
        '*NOTA: Tiene 5 minutos desde este momento para realizar su pago, caso contrario perdera la reserva.*\n\n' +
        'Una vez realizado el pago por favor envie el comprobante de pago, en caso de no poder continuar con la compra, por favor escriba: Cancelar Reserva.'

      await sock.sendMessage(msg.key.remoteJid, {
        image: { url: qrData.qrImageUrl },
        caption: paymentInstructions
      })

      console.log(`Imagen y texto enviados exitosamente a ${msg.key.remoteJid}`)
    } catch (error) {
      console.error('Error procesando el flujo de reserva y orden:', error)
      await sock.sendMessage(msg.key.remoteJid, { 
        text: 'Ocurrio un problema al procesar su orden. Por favor intenta mas tarde.' 
      })
    }
  })
}

connectToWhatsApp()