export interface LetterboxdFilm {
  title: string
  year: number | null
  slug: string
}

export interface WatchlistResponse {
  version: 1
  username: string
  fetchedAt: string
  films: LetterboxdFilm[]
}

export const ERROR_CODES = [
  'INVALID_USERNAME',
  'USER_NOT_FOUND',
  'WATCHLIST_UNAVAILABLE',
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
