import dotenv from 'dotenv'

dotenv.config()

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080/api'
const API_USERNAME = process.env.API_USERNAME || 'Admin'
const API_PASSWORD = process.env.API_PASSWORD || 'Admin'

let cachedToken: string | null = null

export interface ReservationItem {
  id: number
  tiktokUsername: string
  productCode: string
  timestamp: string
  streamId: number
  productId: number
  createdAt: string
  product: {
    id: number
    code: string
    name: string
    stock: number
    price: string
    imageUrl: string
  }
}

export interface CreateOrderPayload {
  clientName: string
  whatsapp: string
  streamId: number
  items: {
    productId: number
    quantity: number
    price: number
  }[]
}

export interface OrderResponseData {
  id: number
  customerName: string
  phone: string
  total: string
  status: string
  streamId: number
  createdAt: string
  items: {
    id: number
    orderId: number
    productId: number
    quantity: number
    price: string
  }[]
}

export interface GenerateQrResponseData {
  qrImageUrl: string
  qrUrl: string
  transactionId?: string
  amount?: string
  currency?: string
  expiresAt?: string
}

async function login(): Promise<string> {
  console.log('Solicitando autenticacion a la API...')
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: API_USERNAME,
      password: API_PASSWORD,
    }),
  })

  if (!response.ok) {
    throw new Error(`Fallo login: ${response.status} ${response.statusText}`)
  }

  const result = await response.json()
  console.log('Login exitoso en la API.')
  cachedToken = result.data.token
  return cachedToken as string
}

async function fetchWithAuth(
  endpoint: string,
  options: RequestInit = {},
): Promise<Response> {
  if (!cachedToken) {
    await login()
  }

  const headers = {
    ...options.headers,
    Authorization: `Bearer ${cachedToken}`,
  }

  let response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  })

  if (response.status === 401) {
    console.log('Token expirado o no autorizado. Reintentando login...')
    await login()
    const retryHeaders = {
      ...options.headers,
      Authorization: `Bearer ${cachedToken}`,
    }
    response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers: retryHeaders,
    })
  }

  return response
}

export async function getActiveReservations(): Promise<ReservationItem[]> {
  console.log('Consultando reservas activas en la API...')
  const response = await fetchWithAuth('/reservations/active')

  if (!response.ok) {
    throw new Error(`Error al consultar reservas: ${response.status}`)
  }

  const result = await response.json()
  console.log(`Reservas activas obtenidas: ${result.data?.length || 0}`)
  return result.data || []
}

export async function createOrder(
  payload: CreateOrderPayload,
): Promise<OrderResponseData> {
  console.log('Creando orden en la API:', JSON.stringify(payload))
  const response = await fetchWithAuth('/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const result = await response.json()

  if (!response.ok) {
    console.error('Detalle error API createOrder:', JSON.stringify(result))
    throw new Error(
      `Error al crear orden: ${response.status} - ${result.message || response.statusText}`,
    )
  }

  console.log('Orden creada exitosamente con ID:', result.data.id)
  return result.data
}

export async function generateQr(
  orderId: number,
): Promise<GenerateQrResponseData> {
  console.log(`Generando QR para la orden ID: ${orderId}...`)
  const response = await fetchWithAuth(`/orders/${orderId}/generate-qr`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })

  if (!response.ok) {
    throw new Error(
      `Error al generar QR: ${response.status} ${response.statusText}`,
    )
  }

  const result = await response.json()
  console.log('QR generado exitosamente para la orden:', orderId)
  return result.data
}
