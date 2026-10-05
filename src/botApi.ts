import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

/** Estados que el vendedor ve en el panel. */
export type BotStatus =
  | 'CONNECTED'
  | 'QR_READY'
  | 'INITIALIZING'
  | 'DISCONNECTED'

interface BotState {
  status: BotStatus
  qr: string | null
  phoneNumber: string | null
  updatedAt: string
}

const state: BotState = {
  status: 'INITIALIZING',
  qr: null,
  phoneNumber: null,
  updatedAt: new Date().toISOString(),
}

/** Carpeta donde Baileys guarda la sesión del dispositivo. */
export const SESSION_DIR = 'auth_info_baileys'

export function setBotStatus(status: BotStatus, extra?: Partial<BotState>): void {
  state.status = status
  if (extra?.qr !== undefined) state.qr = extra.qr
  if (extra?.phoneNumber !== undefined) state.phoneNumber = extra.phoneNumber
  state.updatedAt = new Date().toISOString()
}

export function getBotState(): BotState {
  return { ...state }
}

/**
 * Borra la sesión de WhatsApp del servidor.
 *
 * Sin esto, al reiniciar el bot Baileys volvería a vincular el mismo
 * dispositivo sin volver a pedir el QR.
 */
export function borrarSesion(): void {
  const dir = path.resolve(process.cwd(), SESSION_DIR)

  if (!fs.existsSync(dir)) return

  fs.rmSync(dir, { recursive: true, force: true })
}

export interface BotApiHandlers {
  /** Revoca el vínculo del dispositivo con WhatsApp. */
  onLogout: () => Promise<void>
  /** Levanta una conexión nueva para obtener un QR fresco. */
  onConnect: () => void
}

/**
 * API HTTP mínima para que el panel del vendedor controle la sesión.
 * Sin ella, conectar o desconectar WhatsApp exige mirar la terminal del bot.
 */
export function iniciarApiBot(
  puerto: number,
  handlers: BotApiHandlers,
): http.Server {
  const server = http.createServer((req, res) => {
    // El panel corre en otro puerto, por lo que necesita CORS.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getBotState()))
      return
    }

    if (req.method === 'POST' && req.url === '/connect') {
      // El panel lo usa cuando el bot quedó sin QR: relanzamos la conexión
      // para que Baileys genere uno nuevo.
      setBotStatus('INITIALIZING', { qr: null })
      handlers.onConnect()
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === 'POST' && req.url === '/logout') {
      handlers
        .onLogout()
        .then(() => {
          // Tras cerrar sesión el bot se reconecta solo y queda esperando un
          // QR nuevo, así que el estado correcto es "conectando".
          setBotStatus('INITIALIZING', { qr: null })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        })
        .catch((error) => {
          console.error('Error al cerrar sesion:', error)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              error: error?.message || 'No se pudo cerrar la sesion',
            }),
          )
        })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Ruta no encontrada' }))
  })

  server.listen(puerto, () => {
    console.log(`API del bot escuchando en el puerto ${puerto}`)
  })

  return server
}