import pkg from 'whatsapp-web.js'
const { Client, LocalAuth } = pkg
import qrcode from 'qrcode-terminal'

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
  console.log('CODIGO QR RECIBIDO PARA VINCULAR WHATSAPP:')
  qrcode.generate(qr, { small: true })
})

client.on('authenticated', () => {
  console.log(
    'AUTENTICACION EXITOSA: Sesion restaurada o credenciales validas.',
  )
})

client.on('auth_failure', (msg: string) => {
  console.error('FALLO DE AUTENTICACION:', msg)
})

client.on('ready', () => {
  console.log('CLIENTE LISTO: El bot esta conectado y escuchando mensajes.')
})

client.on('message', async (message) => {
  const contact = await message.getContact()
  console.log('--- NUEVO MENSAJE DETECTADO ---')
  console.log('Remitente:', message.from)
  console.log(
    'Nombre de contacto:',
    contact.pushname || contact.name || 'Desconocido',
  )
  console.log('Tipo de mensaje:', message.type)
  console.log('Texto recibido:', message.body)
  console.log('-------------------------------')
})

console.log('Llamando a client.initialize()...')
client.initialize().catch((err: unknown) => {
  console.error('Error durante client.initialize():', err)
})
