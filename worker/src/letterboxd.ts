import { AppError, type LetterboxdFilm } from './types'
import { hasNextWatchlistPage, parseWatchlistPage } from './parser'

export const MAX_LETTERBOXD_PAGES = 100
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

const LETTERBOXD_ORIGIN = 'https://letterboxd.com'
const USER_AGENT =
  'Mozilla/5.0 (compatible; LampaLetterboxdWatchlist/1.0; +https://github.com/notix3333/lampabox)'

type Fetcher = typeof fetch

const UPSTREAM_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': USER_AGENT,
}

function pageUrl(username: string, page: number): string {
  const encodedUsername = encodeURIComponent(username)
  const suffix = page === 1 ? '' : `page/${page}/`

  return `${LETTERBOXD_ORIGIN}/${encodedUsername}/watchlist/${suffix}`
}

function isBlockedPage(html: string): boolean {
  const normalized = html.toLowerCase()

  return (
    normalized.includes('cf-chl-') ||
    normalized.includes('just a moment...') ||
    normalized.includes('attention required!')
  )
}

function isPrivatePage(html: string): boolean {
  const normalized = html.toLowerCase()

  return (
    normalized.includes('watchlist is private') ||
    normalized.includes('private watchlist') ||
    normalized.includes('watchlist isn’t available') ||
    normalized.includes("watchlist isn't available")
  )
}

async function classifyNotFound(username: string, fetcher: Fetcher): Promise<never> {
  const profileUrl = `${LETTERBOXD_ORIGIN}/${encodeURIComponent(username)}/`
  const response = await fetcher(profileUrl, {
    headers: UPSTREAM_HEADERS,
    redirect: 'follow',
  })

  if (response.status === 403 || response.status === 429) {
    throw new AppError('LETTERBOXD_BLOCKED', 'Letterboxd blocked the request', 502)
  }

  if (response.status === 404) {
    throw new AppError('USER_NOT_FOUND', 'Letterboxd user was not found', 404)
  }

  if (response.ok) {
    throw new AppError('WATCHLIST_UNAVAILABLE', 'Letterboxd watchlist is not public', 404)
  }

  throw new AppError('LETTERBOXD_ERROR', 'Letterboxd returned an upstream error', 502)
}

export async function fetchLetterboxdPage(
  username: string,
  page: number,
  fetcher: Fetcher = fetch,
): Promise<string> {
  let response: Response

  try {
    response = await fetcher(pageUrl(username, page), {
      headers: UPSTREAM_HEADERS,
      redirect: 'follow',
    })
  } catch {
    throw new AppError('LETTERBOXD_ERROR', 'Could not connect to Letterboxd', 502)
  }

  if (response.status === 403 || response.status === 429) {
    throw new AppError('LETTERBOXD_BLOCKED', 'Letterboxd blocked the request', 502)
  }

  if (response.status === 404) return classifyNotFound(username, fetcher)

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

  if (isPrivatePage(html)) {
    throw new AppError('WATCHLIST_UNAVAILABLE', 'Letterboxd watchlist is not public', 404)
  }

  return html
}

export async function fetchWatchlist(
  username: string,
  fetcher: Fetcher = fetch,
): Promise<LetterboxdFilm[]> {
  const films: LetterboxdFilm[] = []
  const seen = new Set<string>()

  for (let page = 1; page <= MAX_LETTERBOXD_PAGES; page += 1) {
    const html = await fetchLetterboxdPage(username, page, fetcher)
    const pageFilms = parseWatchlistPage(html)

    for (const film of pageFilms) {
      if (seen.has(film.slug)) continue

      seen.add(film.slug)
      films.push(film)
    }

    const hasNext = hasNextWatchlistPage(html, page + 1)

    if (!hasNext) return films

    if (page === MAX_LETTERBOXD_PAGES) {
      throw new AppError('LETTERBOXD_ERROR', 'Letterboxd watchlist exceeded the page limit', 502)
    }
  }

  return films
}
