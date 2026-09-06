import {
  AppError,
  type PublicListResponse,
  type WatchedResponse,
  type WatchlistResponse,
} from './types'
import { fetchPublicList, fetchWatchedPage, fetchWatchlist } from './letterboxd'
import { readPresetsResponse } from './presets'
import {
  collectNextWatchedProfile,
  seedAndReadWatchedResponse,
  type WatchedCacheBinding,
} from './watched-cache'

export interface Env {
  WATCHED_CACHE?: WatchedCacheBinding
}

interface ScheduledController {
  scheduledTime: number
  cron: string
}

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

function watchedUsernameFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/watched\/([^/]+)\/?$/)
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

export async function handleRequest(request: Request, env: Env = {}): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: COMMON_HEADERS })
  }

  if (request.method !== 'GET') {
    return jsonResponse(
      { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET and OPTIONS are supported' } },
      405,
    )
  }

  const url = new URL(request.url)
  const pathname = url.pathname
  const list = listFromPath(pathname)
  const watchedUsername = watchedUsernameFromPath(pathname)
  const username = usernameFromPath(pathname)

  if (/^\/presets\/?$/.test(pathname)) {
    return jsonResponse(await readPresetsResponse(env.WATCHED_CACHE))
  }

  if (watchedUsername !== null) {
    if (!USERNAME_PATTERN.test(watchedUsername)) {
      return errorResponse(new AppError('INVALID_USERNAME', 'Letterboxd username is invalid', 400))
    }

    const page = Number(url.searchParams.get('page') || 1)
    if (!Number.isInteger(page) || page < 1 || page > 100) {
      return errorResponse(new AppError('INVALID_PAGE', 'Letterboxd page is invalid', 400))
    }

    try {
      if (env.WATCHED_CACHE) {
        return jsonResponse(
          await seedAndReadWatchedResponse(env.WATCHED_CACHE, watchedUsername, page),
        )
      }

      const { films, nextPage, total } = await fetchWatchedPage(watchedUsername, page)
      const result: WatchedResponse = {
        version: 1,
        kind: 'watched',
        username: watchedUsername,
        title: 'Letterboxd Watched',
        page,
        nextPage,
        total,
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

export async function handleScheduled(
  _controller: ScheduledController,
  env: Env,
): Promise<void> {
  if (!env.WATCHED_CACHE) {
    console.warn('WATCHED_CACHE is not configured; scheduled collection was skipped')
    return
  }

  try {
    const result = await collectNextWatchedProfile(env.WATCHED_CACHE)
    if (result) console.log('Collected one Letterboxd watched page', result)
  } catch (error) {
    // collectWatchedProfile has already persisted the retry deadline and kept
    // the last successful snapshot. Logging here keeps Cron retries observable.
    console.error('Scheduled Letterboxd collection failed', error)
  }
}

export default {
  fetch: handleRequest,
  scheduled: handleScheduled,
}
