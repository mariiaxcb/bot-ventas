import pkg from 'whatsapp-web.js'
const { Client, LocalAuth } = pkg
import qrcode from 'qrcode-terminal'
import dotenv from 'dotenv'
import { getActiveReservations } from './api.service.js'

dotenv.config()

console.log('Iniciando configuracion del cliente de WhatsApp...')

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './.wwebjs_auth',
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
  },
})

client.on('qr', (qr: string) => {
  console.log('CODIGO QR RECIBIDO:')
  qrcode.generate(qr, { small: true })
})

client.on('authenticated', () => {
  console.log('AUTENTICACION EXITOSA: Sesion restaurada.')
})

client.on('auth_failure', (msg: string) => {
  console.error('FALLO DE AUTENTICACION:', msg)
})

client.on('ready', () => {
  console.log('CLIENTE LISTO: Bot escuchando mensajes.')
})

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

client.on('message', async (message) => {
  if (message.type !== 'chat') {
    return
  }

  if (message.from.endsWith('@g.us')) {
    return
  }

  const incomingText = message.body || ''
  console.log('--- MENSAJE DE CHAT RECIBIDO ---')
  console.log('De:', message.from)
  console.log('Texto:', incomingText)

  const parsedData = parseReservationMessage(incomingText)

  if (!parsedData) {
    console.log('Mensaje no coincide con el formato. Enviando instrucciones.')
    await client.sendMessage(
      message.from,
      'Gracias por comunicarte con Tienda LiveSales, Si realizaste una reserva por tiktok, por favor envianos la siguiente informacion en este formato:',
    )
    await client.sendMessage(
      message.from,
      'nombre de usuario:\ncodigo de producto:',
    )
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

    if (found) {
      console.log(`Reserva encontrada exitosamente: ID ${found.id}`)
      await client.sendMessage(message.from, 'Reserva verificada')
    } else {
      console.log('Reserva no encontrada en la lista activa.')
      await client.sendMessage(
        message.from,
        'Debe ir al live de @LiveSales y realizar su reserva.',
      )
    }
  } catch (error) {
    console.error('Error procesando la verificacion:', error)
    await client.sendMessage(
      message.from,
      'Ocurrio un problema al verificar la reserva. Por favor intenta mas tarde.',
    )
  }
})

console.log('Llamando a client.initialize()...')
client.initialize().catch((err: unknown) => {
  console.error('Error durante client.initialize():', err)
})
