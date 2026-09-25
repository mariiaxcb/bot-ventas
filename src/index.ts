import pkg from 'whatsapp-web.js'
const { Client, LocalAuth, MessageMedia } = pkg
import qrcode from 'qrcode-terminal'
import dotenv from 'dotenv'
import {
  getActiveReservations,
  createOrder,
  generateQr,
} from './api.service.js'

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
): { username: string; productCode: string; phone: string } | null {
  const clean = text.trim()
  const userRegex = /(?:nombre\s*de\s*usuario|usuario|user)\s*:\s*([^\n\r]+)/i
  const productRegex =
    /(?:codigo\s*de\s*producto|producto|codigo)\s*:\s*([^\n\r]+)/i
  const phoneRegex =
    /(?:numero\s*de\s*whatsapp|whatsapp|telefono|numero)\s*:\s*([^\n\r]+)/i

  const userMatch = clean.match(userRegex)
  const productMatch = clean.match(productRegex)
  const phoneMatch = clean.match(phoneRegex)

  if (userMatch && productMatch && phoneMatch) {
    return {
      username: userMatch[1].trim().toLowerCase().replace(/^@/, ''),
      productCode: productMatch[1].trim().toUpperCase(),
      phone: phoneMatch[1].trim(),
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
      'nombre de usuario:\ncodigo de producto:\nnumero de whatsapp:',
    )
    return
  }

  console.log('Datos extraidos con exito:')
  console.log('Usuario:', parsedData.username)
  console.log('Codigo de producto:', parsedData.productCode)
  console.log('Numero ingresado:', parsedData.phone)

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
      await client.sendMessage(
        message.from,
        'Debe ir al live de @LiveSales y realizar su reserva.',
      )
      return
    }

    console.log(`Reserva verificada exitosamente: ID ${found.id}`)

    let cleanPhone = parsedData.phone.replace(/\D/g, '')

    if (cleanPhone.length <= 8) {
      cleanPhone = `591${cleanPhone}`
    }

    const sendTarget = `${cleanPhone}@c.us`
    const priceNumber = parseFloat(found.product.price)

    console.log(
      `Procediendo a crear orden para cliente: ${found.tiktokUsername}, Telefono: ${cleanPhone}`,
    )

    const order = await createOrder({
      clientName: found.tiktokUsername,
      whatsapp: cleanPhone,
      streamId: found.streamId,
      items: [
        {
          productId: found.productId,
          quantity: 1,
          price: priceNumber,
        },
      ],
    })

    console.log(
      `Orden #${order.id} creada. Solicitando QR a Canela Bank y Cloudinary...`,
    )

    if (message.from !== sendTarget) {
      await client.sendMessage(
        message.from,
        `Orden generada. Enviaremos el QR y las instrucciones a su numero: ${cleanPhone}`,
      )
    }

    const qrData = await generateQr(order.id)

    const media = await MessageMedia.fromUrl(qrData.qrImageUrl)

    const paymentInstructions =
      'Por favor realice el pago de su producto con el siguiente QR o ingresando al enlace de pago directo:\n' +
      `${qrData.qrUrl}\n\n` +
      '*NOTA: Tiene 5 minutos desde este momento para realizar su pago, caso contrario perdera la reserva.*\n\n' +
      'Una vez realizado el pago por favor envie el comprobante de pago, en caso de no poder continuar con la compra, por favor escriba: Cancelar Reserva.'

    await client.sendMessage(sendTarget, media, {
      caption: paymentInstructions,
    })

    console.log(`Imagen y texto enviados exitosamente a ${sendTarget}`)
  } catch (error) {
    console.error('Error procesando el flujo de reserva y orden:', error)
    await client.sendMessage(
      message.from,
      'Ocurrio un problema al procesar su orden. Por favor intenta mas tarde.',
    )
  }
})

console.log('Llamando a client.initialize()...')
client.initialize().catch((err: unknown) => {
  console.error('Error durante client.initialize():', err)
})
