export interface LetterboxdFilm {
  title: string
  year: number | null
  slug: string
}

export interface WatchlistResponse {
  version: 1
  kind: 'watchlist'
  username: string
  title: string
  fetchedAt: string
  films: LetterboxdFilm[]
}

export interface PublicListResponse {
  version: 1
  kind: 'list'
  username: string
  slug: string
  title: string
  fetchedAt: string
  films: LetterboxdFilm[]
}

export interface WatchedResponse {
  version: 1
  kind: 'watched'
  username: string
  title: string
  page: number
  nextPage: number | null
  total: number | null
  fetchedAt: string
  films: LetterboxdFilm[]
  cache?: {
    status: 'building' | 'complete'
    collectedFilms: number
    sourcePages: number | null
    nextSourcePage: number
    nextAttemptAt: string
    lastSuccessAt: string | null
    lastFailureAt: string | null
  }
}

export const ERROR_CODES = [
  'INVALID_USERNAME',
  'INVALID_LIST',
  'INVALID_PAGE',
  'USER_NOT_FOUND',
  'WATCHLIST_UNAVAILABLE',
  'LIST_UNAVAILABLE',
  'WATCHED_UNAVAILABLE',
  'LETTERBOXD_BLOCKED',
  'LETTERBOXD_ERROR',
  'PARSER_ERROR',
  'INTERNAL_ERROR',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number

  constructor(code: ErrorCode, message: string, status: number) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = status
  }
}
