import { AppError, type PublicListResponse, type WatchlistResponse } from './types'
import { fetchPublicList, fetchWatchlist } from './letterboxd'

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/i
const LIST_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/i

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

function listFromPath(pathname: string): { username: string; slug: string } | null {
  const match = pathname.match(/^\/list\/([^/]+)\/([^/]+)\/?$/)
  if (!match) return null

  try {
    return { username: decodeURIComponent(match[1]), slug: decodeURIComponent(match[2]) }
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

  const pathname = new URL(request.url).pathname
  const list = listFromPath(pathname)
  const username = usernameFromPath(pathname)

  if (list) {
    if (!USERNAME_PATTERN.test(list.username)) {
      return errorResponse(new AppError('INVALID_USERNAME', 'Letterboxd username is invalid', 400))
    }

    if (!LIST_SLUG_PATTERN.test(list.slug)) {
      return errorResponse(new AppError('INVALID_LIST', 'Letterboxd list slug is invalid', 400))
    }

    try {
      const { films, title } = await fetchPublicList(list.username, list.slug)
      const result: PublicListResponse = {
        version: 1,
        kind: 'list',
        username: list.username,
        slug: list.slug,
        title: title || list.slug,
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

  if (!username || !USERNAME_PATTERN.test(username)) {
    return errorResponse(
      new AppError('INVALID_USERNAME', 'Letterboxd username is invalid', 400),
    )
  }

  try {
    const films = await fetchWatchlist(username)
    const result: WatchlistResponse = {
      version: 1,
      kind: 'watchlist',
      username,
      title: 'Letterboxd Watchlist',
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
