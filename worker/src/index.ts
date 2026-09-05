import { AppError, type WatchlistResponse } from './types'
import { fetchWatchlist } from './letterboxd'

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/i

const COMMON_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
}

function errorResponse(error: AppError): Response {
  return jsonResponse(
    {
      error: {
        code: error.code,
        message: error.message,
      },
    },
    error.status,
  )
}

function usernameFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/watchlist\/([^/]+)\/?$/)

  if (!match) return null

  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

export async function handleRequest(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: COMMON_HEADERS })
  }

  if (request.method !== 'GET') {
    return jsonResponse(
      { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET and OPTIONS are supported' } },
      405,
    )
  }

  const username = usernameFromPath(new URL(request.url).pathname)

  if (!username || !USERNAME_PATTERN.test(username)) {
    return errorResponse(
      new AppError('INVALID_USERNAME', 'Letterboxd username is invalid', 400),
    )
  }

  try {
    const films = await fetchWatchlist(username)
    const result: WatchlistResponse = {
      version: 1,
      username,
      fetchedAt: new Date().toISOString(),
      films,
    }

    return jsonResponse(result)
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error)

    console.error('Unexpected worker error', error)
    return errorResponse(new AppError('INTERNAL_ERROR', 'Unexpected internal error', 500))
  }
}

export default {
  fetch: handleRequest,
}
