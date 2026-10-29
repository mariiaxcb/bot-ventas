import dotenv from 'dotenv'

dotenv.config()

/**
 * Servicio centralizado de autenticación contra el backend.
 *
 * Unifica el token de acceso usado tanto por las peticiones REST
 * (api.service.ts) como por la conexión WebSocket del bot
 * (connectToBackendSocket en index.ts), de modo que haya una sola fuente
 * de verdad y no se dupliquen credenciales ni tokens en varios módulos.
 *
 * Características:
 *  - Evita login duplicados concurrentes (promesa compartida).
 *  - Refresca el token 30 segundos antes de que expire.
 *  - Permite invalidad el token forzosamente (ej. tras un 401 o error de socket).
 */

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080'
const API_EMAIL = process.env.API_EMAIL || 'mariiaxcb@gmail.com'
const API_PASSWORD = process.env.API_PASSWORD || 'Megaman123$'

interface TokenData {
  token: string
  expiresAt: number // momento (ms) a partir del cual el token se considera expirado
}

let cached: TokenData | null = null
let loginEnCurso: Promise<string> | null = null

async function login(): Promise<string> {
  console.log('Solicitando autenticacion a la API...')
  const response = await fetch(`${BACKEND_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: API_EMAIL,
      password: API_PASSWORD,
    }),
  })

  if (!response.ok) {
    const texto = await response.text().catch(() => '')
    throw new Error(
      `Login fallo (${response.status}): ${texto || response.statusText}`,
    )
  }

  const result = await response.json()
  const token = result.data?.token
  if (!token) {
    throw new Error('El backend no devolvio un token de autenticacion')
  }

  // Expiracion del JWT: el backend lo firma con JWT_EXPIRES_IN (default 1d).
  // Refrescamos 30 segundos antes para no usar un token a punto de caducar.
  const expiresInSegundos =
    typeof result.data?.expiresIn === 'number'
      ? result.data.expiresIn
      : 86_400
  const expiresAt = Date.now() + expiresInSegundos * 1000 - 30_000

  cached = { token, expiresAt }
  console.log('Login exitoso en la API.')
  return token
}

/**
 * Devuelve un token valido. Si no hay uno o ya expiro, hace login.
 * Los llamados concurrentes comparten la misma promesa de login para no
 * saturar al backend con peticiones de autenticacion simultaneas.
 */
export async function obtenerToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token
  }

  if (loginEnCurso) {
    return loginEnCurso
  }

  loginEnCurso = (async () => {
    try {
      return await login()
    } finally {
      loginEnCurso = null
    }
  })()

  return loginEnCurso
}

/**
 * Invalida el token en memoria para forzar un nuevo login en la siguiente
 * peticion. Usarlo tras recibir un 401 o un error de autenticacion del socket.
 */
export function invalidarToken(): void {
  cached = null
}
