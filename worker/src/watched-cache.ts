import { fetchWatchedPage } from './letterboxd'
import { AppError, type ErrorCode, type LetterboxdFilm, type WatchedResponse } from './types'

const CACHE_KEY_PREFIX = 'watched-cache:v1:'
const API_PAGE_SIZE = 100
const NEXT_PAGE_DELAY_MS = 30_000
const REFRESH_DELAY_MS = 12 * 60 * 60 * 1000
const BACKOFF_BASE_MS = 5 * 60 * 1000
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000
const JITTER_MAX_MS = 2 * 60 * 1000

export interface WatchedCacheBinding {
  get(key: string, type: 'json'): Promise<unknown>
  put(key: string, value: string): Promise<void>
  list(options?: {
    prefix?: string
    limit?: number
    cursor?: string
  }): Promise<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }>
}

interface CachedFailure {
  code: ErrorCode
  message: string
  status: number
  at: string
}

export interface WatchedCacheState {
  version: 1
  username: string
  activeFilms: LetterboxdFilm[]
  hasCompleteSnapshot: boolean
  pendingPages: Record<string, LetterboxdFilm[]>
  nextSourcePage: number
  total: number | null
  failures: number
  nextAttemptAt: string
  createdAt: string
  updatedAt: string
  lastSuccessAt: string | null
  completedAt: string | null
  lastFailure: CachedFailure | null
}

export interface CollectionResult {
  username: string
  sourcePage: number
  storedFilms: number
  complete: boolean
  nextSourcePage: number
  nextAttemptAt: string
}

type WatchedPageFetcher = typeof fetchWatchedPage

interface CollectionOptions {
  now?: number
  random?: () => number
  fetchPage?: WatchedPageFetcher
}

function cacheKey(username: string): string {
  return `${CACHE_KEY_PREFIX}${username.toLowerCase()}`
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString()
}

function jitter(random: () => number): number {
  return Math.floor(Math.max(0, Math.min(1, random())) * JITTER_MAX_MS)
}

function emptyState(username: string, now: number): WatchedCacheState {
  const timestamp = iso(now)

  return {
    version: 1,
    username,
    activeFilms: [],
    hasCompleteSnapshot: false,
    pendingPages: {},
    nextSourcePage: 1,
    total: null,
    failures: 0,
    nextAttemptAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSuccessAt: null,
    completedAt: null,
    lastFailure: null,
  }
}

function isFilm(value: unknown): value is LetterboxdFilm {
  if (!value || typeof value !== 'object') return false
  const film = value as Partial<LetterboxdFilm>

  return (
    typeof film.title === 'string' &&
    typeof film.slug === 'string' &&
    (film.year === null || typeof film.year === 'number')
  )
}

function isState(value: unknown): value is WatchedCacheState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<WatchedCacheState>

  return (
    state.version === 1 &&
    typeof state.username === 'string' &&
    Array.isArray(state.activeFilms) &&
    state.activeFilms.every(isFilm) &&
    typeof state.hasCompleteSnapshot === 'boolean' &&
    !!state.pendingPages &&
    typeof state.pendingPages === 'object' &&
    Number.isInteger(state.nextSourcePage) &&
    typeof state.nextAttemptAt === 'string'
  )
}

async function readState(
  cache: WatchedCacheBinding,
  username: string,
): Promise<WatchedCacheState | null> {
  const value = await cache.get(cacheKey(username), 'json')
  return isState(value) ? value : null
}

async function writeState(cache: WatchedCacheBinding, state: WatchedCacheState): Promise<void> {
  await cache.put(cacheKey(state.username), JSON.stringify(state))
}

function mergePages(pages: Record<string, LetterboxdFilm[]>): LetterboxdFilm[] {
  const films: LetterboxdFilm[] = []
  const seen = new Set<string>()
  const pageNumbers = Object.keys(pages)
    .map(Number)
    .filter((page) => Number.isInteger(page) && page > 0)
    .sort((left, right) => left - right)

  for (const page of pageNumbers) {
    for (const film of pages[String(page)] || []) {
      if (seen.has(film.slug)) continue
      seen.add(film.slug)
      films.push(film)
    }
  }

  return films
}

function visibleFilms(state: WatchedCacheState): LetterboxdFilm[] {
  return state.hasCompleteSnapshot ? state.activeFilms : mergePages(state.pendingPages)
}

function failureFrom(error: unknown, now: number): CachedFailure {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      at: iso(now),
    }
  }

  return {
    code: 'INTERNAL_ERROR',
    message: 'Unexpected background collector error',
    status: 500,
    at: iso(now),
  }
}

export async function registerWatchedProfile(
  cache: WatchedCacheBinding,
  username: string,
  now = Date.now(),
): Promise<WatchedCacheState> {
  const existing = await readState(cache, username)
  if (existing) return existing

  const state = emptyState(username, now)
  await writeState(cache, state)
  return state
}

export async function collectWatchedProfile(
  cache: WatchedCacheBinding,
  username: string,
  options: CollectionOptions = {},
): Promise<CollectionResult> {
  const now = options.now ?? Date.now()
  const random = options.random ?? Math.random
  const fetchPage = options.fetchPage ?? fetchWatchedPage
  const state = (await readState(cache, username)) ?? emptyState(username, now)
  const sourcePage = state.nextSourcePage

  try {
    const result = await fetchPage(state.username, sourcePage)
    const pendingPages =
      sourcePage === 1
        ? { '1': result.films }
        : { ...state.pendingPages, [String(sourcePage)]: result.films }
    const completed = result.nextPage === null
    const completedFilms = completed ? mergePages(pendingPages) : state.activeFilms
    const nextAttemptDelay = completed ? REFRESH_DELAY_MS : NEXT_PAGE_DELAY_MS
    const updated: WatchedCacheState = {
      ...state,
      activeFilms: completedFilms,
      hasCompleteSnapshot: completed || state.hasCompleteSnapshot,
      pendingPages: completed ? {} : pendingPages,
      nextSourcePage: result.nextPage ?? 1,
      total: result.total ?? state.total,
      failures: 0,
      nextAttemptAt: iso(now + nextAttemptDelay + jitter(random)),
      updatedAt: iso(now),
      lastSuccessAt: iso(now),
      completedAt: completed ? iso(now) : state.completedAt,
      lastFailure: null,
    }

    // A successful page is persisted as part of the new state. A failed crawl
    // never reaches this write path, so the last good complete snapshot survives.
    await writeState(cache, updated)

    return {
      username: updated.username,
      sourcePage,
      storedFilms: visibleFilms(updated).length,
      complete: updated.hasCompleteSnapshot && completed,
      nextSourcePage: updated.nextSourcePage,
      nextAttemptAt: updated.nextAttemptAt,
    }
  } catch (error) {
    const failures = state.failures + 1
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 10))
    const updated: WatchedCacheState = {
      ...state,
      failures,
      nextAttemptAt: iso(now + backoff + jitter(random)),
      updatedAt: iso(now),
      lastFailure: failureFrom(error, now),
    }

    await writeState(cache, updated)
    throw error
  }
}

export async function readWatchedResponse(
  cache: WatchedCacheBinding,
  username: string,
  page: number,
): Promise<WatchedResponse | null> {
  const state = await readState(cache, username)
  if (!state) return null

  const allFilms = visibleFilms(state)
  if (allFilms.length === 0) return null

  const start = (page - 1) * API_PAGE_SIZE
  const films = allFilms.slice(start, start + API_PAGE_SIZE)
  const nextPage = start + API_PAGE_SIZE < allFilms.length ? page + 1 : null

  return {
    version: 1,
    kind: 'watched',
    username: state.username,
    title: 'Letterboxd Watched',
    page,
    nextPage,
    total: state.total,
    fetchedAt: state.lastSuccessAt || state.updatedAt,
    films,
    cache: {
      status: state.hasCompleteSnapshot ? 'complete' : 'building',
      collectedFilms: allFilms.length,
      sourcePages: state.hasCompleteSnapshot
        ? null
        : Object.keys(state.pendingPages).length,
      nextSourcePage: state.nextSourcePage,
      nextAttemptAt: state.nextAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailure?.at ?? null,
    },
  }
}

export async function seedAndReadWatchedResponse(
  cache: WatchedCacheBinding,
  username: string,
  page: number,
  options: CollectionOptions = {},
): Promise<WatchedResponse> {
  const now = options.now ?? Date.now()
  let state = await registerWatchedProfile(cache, username, now)
  let response = await readWatchedResponse(cache, username, page)
  if (response) return response

  if (Date.parse(state.nextAttemptAt) <= now) {
    await collectWatchedProfile(cache, username, options)
    response = await readWatchedResponse(cache, username, page)
    if (response) return response
    state = (await readState(cache, username)) ?? state
  }

  const previous = state.lastFailure
  throw new AppError(
    previous?.code ?? 'LETTERBOXD_ERROR',
    previous?.message ?? 'Watched-film cache is waiting for the next collection attempt',
    previous?.status ?? 502,
  )
}

export async function collectNextWatchedProfile(
  cache: WatchedCacheBinding,
  options: CollectionOptions = {},
): Promise<CollectionResult | null> {
  const now = options.now ?? Date.now()
  let cursor: string | undefined
  let selected: WatchedCacheState | null = null

  do {
    const page = await cache.list({ prefix: CACHE_KEY_PREFIX, limit: 100, cursor })

    for (const key of page.keys) {
      const username = key.name.slice(CACHE_KEY_PREFIX.length)
      const state = await readState(cache, username)
      if (!state || Date.parse(state.nextAttemptAt) > now) continue

      if (!selected || Date.parse(state.nextAttemptAt) < Date.parse(selected.nextAttemptAt)) {
        selected = state
      }
    }

    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)

  if (!selected) return null

  return collectWatchedProfile(cache, selected.username, options)
}
