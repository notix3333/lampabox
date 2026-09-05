import { AppError, type LetterboxdFilm } from './types'
import {
  hasNextListPage,
  hasNextFilmsPage,
  hasNextWatchlistPage,
  parseListPage,
  parseListTitle,
  parseFilmsPage,
  parseWatchlistPage,
} from './parser'

export const MAX_LETTERBOXD_PAGES = 100
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

const LETTERBOXD_ORIGIN = 'https://letterboxd.com'
const USER_AGENT =
  'Mozilla/5.0 (compatible; LampaLetterboxdWatchlist/1.2.1; +https://github.com/notix3333/lampabox)'
const RETRY_DELAYS_MS = [250, 500]

type Fetcher = typeof fetch
type Sleeper = (delayMs: number) => Promise<void>
type CollectionTarget =
  | { kind: 'watchlist'; username: string }
  | { kind: 'list'; username: string; slug: string }
  | { kind: 'watched'; username: string }

const UPSTREAM_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': USER_AGENT,
}

const sleep: Sleeper = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))

function pageUrl(target: CollectionTarget, page: number): string {
  const encodedUsername = encodeURIComponent(target.username)
  const suffix = page === 1 ? '' : `page/${page}/`

  if (target.kind === 'watchlist') {
    return `${LETTERBOXD_ORIGIN}/${encodedUsername}/watchlist/${suffix}`
  }

  if (target.kind === 'watched') {
    return `${LETTERBOXD_ORIGIN}/${encodedUsername}/films/${suffix}`
  }

  return `${LETTERBOXD_ORIGIN}/${encodedUsername}/list/${encodeURIComponent(target.slug)}/${suffix}`
}

function isBlockedPage(html: string): boolean {
  const normalized = html.toLowerCase()

  return (
    normalized.includes('cf-chl-') ||
    normalized.includes('just a moment...') ||
    normalized.includes('attention required!')
  )
}

function isPrivatePage(html: string, target: CollectionTarget): boolean {
  const normalized = html.toLowerCase()

  if (target.kind === 'watchlist') {
    return (
      normalized.includes('watchlist is private') ||
      normalized.includes('private watchlist') ||
      normalized.includes('watchlist isn’t available') ||
      normalized.includes("watchlist isn't available")
    )
  }

  if (target.kind === 'watched') {
    return (
      normalized.includes('films are private') ||
      normalized.includes('private films') ||
      normalized.includes('films aren’t available') ||
      normalized.includes("films aren't available")
    )
  }

  return (
    normalized.includes('this list is private') ||
    normalized.includes('list isn’t available') ||
    normalized.includes("list isn't available")
  )
}

async function fetchWithRetry(
  url: string,
  fetcher: Fetcher,
  sleeper: Sleeper,
): Promise<Response> {
  let lastError: unknown

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetcher(url, {
        headers: UPSTREAM_HEADERS,
        redirect: 'follow',
      })
      const transient = response.status === 429 || response.status >= 500

      if (!transient || attempt === RETRY_DELAYS_MS.length) return response
    } catch (error) {
      lastError = error
      if (attempt === RETRY_DELAYS_MS.length) break
    }

    await sleeper(RETRY_DELAYS_MS[attempt])
  }

  throw new AppError(
    'LETTERBOXD_ERROR',
    lastError ? 'Could not connect to Letterboxd' : 'Letterboxd returned an upstream error',
    502,
  )
}

async function classifyNotFound(
  target: CollectionTarget,
  fetcher: Fetcher,
  sleeper: Sleeper,
): Promise<never> {
  const profileUrl = `${LETTERBOXD_ORIGIN}/${encodeURIComponent(target.username)}/`
  const response = await fetchWithRetry(profileUrl, fetcher, sleeper)

  if (response.status === 403 || response.status === 429) {
    throw new AppError('LETTERBOXD_BLOCKED', 'Letterboxd blocked the request', 502)
  }

  if (response.status === 404) {
    throw new AppError('USER_NOT_FOUND', 'Letterboxd user was not found', 404)
  }

  if (response.ok) {
    if (target.kind === 'watchlist') {
      throw new AppError('WATCHLIST_UNAVAILABLE', 'Letterboxd watchlist is not public', 404)
    }

    if (target.kind === 'list') {
      throw new AppError('LIST_UNAVAILABLE', 'Letterboxd list was not found or is not public', 404)
    }

    throw new AppError('WATCHED_UNAVAILABLE', 'Letterboxd watched films are not public', 404)
  }

  throw new AppError('LETTERBOXD_ERROR', 'Letterboxd returned an upstream error', 502)
}

async function fetchCollectionPage(
  target: CollectionTarget,
  page: number,
  fetcher: Fetcher,
  sleeper: Sleeper,
): Promise<string> {
  const response = await fetchWithRetry(pageUrl(target, page), fetcher, sleeper)

  if (response.status === 403 || response.status === 429) {
    throw new AppError('LETTERBOXD_BLOCKED', 'Letterboxd blocked the request', 502)
  }

  if (response.status === 404) return classifyNotFound(target, fetcher, sleeper)

  if (!response.ok) {
    throw new AppError('LETTERBOXD_ERROR', 'Letterboxd returned an upstream error', 502)
  }

  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new AppError('LETTERBOXD_ERROR', 'Letterboxd response is too large', 502)
  }

  const html = await response.text()
  if (new TextEncoder().encode(html).byteLength > MAX_RESPONSE_BYTES) {
    throw new AppError('LETTERBOXD_ERROR', 'Letterboxd response is too large', 502)
  }

  if (isBlockedPage(html)) {
    throw new AppError('LETTERBOXD_BLOCKED', 'Letterboxd blocked the request', 502)
  }

  if (isPrivatePage(html, target)) {
    const code =
      target.kind === 'watchlist'
        ? 'WATCHLIST_UNAVAILABLE'
        : target.kind === 'list'
          ? 'LIST_UNAVAILABLE'
          : 'WATCHED_UNAVAILABLE'
    const message =
      target.kind === 'watchlist'
        ? 'Letterboxd watchlist is not public'
        : target.kind === 'list'
          ? 'Letterboxd list was not found or is not public'
          : 'Letterboxd watched films are not public'
    throw new AppError(code, message, 404)
  }

  return html
}

export async function fetchLetterboxdPage(
  username: string,
  page: number,
  fetcher: Fetcher = fetch,
  sleeper: Sleeper = sleep,
): Promise<string> {
  return fetchCollectionPage({ kind: 'watchlist', username }, page, fetcher, sleeper)
}

async function fetchCollection(
  target: CollectionTarget,
  fetcher: Fetcher,
  sleeper: Sleeper,
): Promise<{ films: LetterboxdFilm[]; title: string | null }> {
  const films: LetterboxdFilm[] = []
  const seen = new Set<string>()
  let title: string | null = null

  for (let page = 1; page <= MAX_LETTERBOXD_PAGES; page += 1) {
    const html = await fetchCollectionPage(target, page, fetcher, sleeper)
    const pageFilms =
      target.kind === 'watchlist'
        ? parseWatchlistPage(html)
        : target.kind === 'list'
          ? parseListPage(html)
          : parseFilmsPage(html)

    if (page === 1 && target.kind === 'list') title = parseListTitle(html)

    for (const film of pageFilms) {
      if (seen.has(film.slug)) continue

      seen.add(film.slug)
      films.push(film)
    }

    const hasNext =
      target.kind === 'watchlist'
        ? hasNextWatchlistPage(html, page + 1)
        : target.kind === 'list'
          ? hasNextListPage(html, target.slug, page + 1)
          : hasNextFilmsPage(html, page + 1)

    if (!hasNext) return { films, title }

    if (page === MAX_LETTERBOXD_PAGES) {
      throw new AppError('LETTERBOXD_ERROR', 'Letterboxd collection exceeded the page limit', 502)
    }
  }

  return { films, title }
}

export async function fetchPublicList(
  username: string,
  slug: string,
  fetcher: Fetcher = fetch,
  sleeper: Sleeper = sleep,
): Promise<{ films: LetterboxdFilm[]; title: string | null }> {
  return fetchCollection({ kind: 'list', username, slug }, fetcher, sleeper)
}

export async function fetchWatchlist(
  username: string,
  fetcher: Fetcher = fetch,
  sleeper: Sleeper = sleep,
): Promise<LetterboxdFilm[]> {
  const result = await fetchCollection({ kind: 'watchlist', username }, fetcher, sleeper)
  return result.films
}

export async function fetchWatched(
  username: string,
  fetcher: Fetcher = fetch,
  sleeper: Sleeper = sleep,
): Promise<LetterboxdFilm[]> {
  const result = await fetchCollection({ kind: 'watched', username }, fetcher, sleeper)
  return result.films
}

export async function fetchWatchedPage(
  username: string,
  page: number,
  fetcher: Fetcher = fetch,
  sleeper: Sleeper = sleep,
): Promise<{ films: LetterboxdFilm[]; nextPage: number | null }> {
  const target: CollectionTarget = { kind: 'watched', username }
  const html = await fetchCollectionPage(target, page, fetcher, sleeper)
  const films = parseFilmsPage(html)

  return {
    films,
    nextPage: hasNextFilmsPage(html, page + 1) ? page + 1 : null,
  }
}
