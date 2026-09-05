import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  hasNextListPage,
  hasNextFilmsPage,
  hasNextWatchlistPage,
  parseListPage,
  parseListTitle,
  parseFilmsPage,
  parseWatchlistPage,
} from '../src/parser'
import { AppError } from '../src/types'

const fixture = (name: string) =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('parseWatchlistPage', () => {
  it('extracts title, year and slug in source order', async () => {
    const films = parseWatchlistPage(await fixture('watchlist-page.html'))

    expect(films).toEqual([
      { title: 'Dune: Part Two', year: 2024, slug: 'dune-part-two' },
      { title: 'Anora', year: 2024, slug: 'anora' },
      { title: 'Aftersun', year: 2022, slug: 'aftersun' },
    ])
  })

  it('returns an empty array for a valid empty watchlist', async () => {
    expect(parseWatchlistPage(await fixture('empty-watchlist.html'))).toEqual([])
  })

  it('deduplicates films by slug', async () => {
    const films = parseWatchlistPage(await fixture('watchlist-page.html'))

    expect(films.filter((film) => film.slug === 'anora')).toHaveLength(1)
  })

  it('fails with a controlled parser error for unrecognized HTML', () => {
    expect(() => parseWatchlistPage('<html><body>upstream changed</body></html>')).toThrowError(
      expect.objectContaining<Partial<AppError>>({ code: 'PARSER_ERROR' }),
    )
  })

  it('detects only the expected next page link', async () => {
    const html = await fixture('watchlist-page.html')

    expect(hasNextWatchlistPage(html, 2)).toBe(true)
    expect(hasNextWatchlistPage(html, 3)).toBe(false)
  })
})

describe('parseListPage', () => {
  it('extracts ordered items and the public list title', async () => {
    const html = await fixture('list-page.html')

    expect(parseListPage(html)).toEqual([
      { title: 'Shōgun', year: 2024, slug: 'shogun-2024' },
      { title: 'Dune: Part Two', year: 2024, slug: 'dune-part-two' },
    ])
    expect(parseListTitle(html)).toBe('Great Television & Films')
    expect(hasNextListPage(html, 'great-television-and-films', 2)).toBe(true)
    expect(hasNextListPage(html, 'other-list', 2)).toBe(false)
  })

  it('rejects unrelated HTML', () => {
    expect(() => parseListPage('<html><body>not a list</body></html>')).toThrowError(
      expect.objectContaining<Partial<AppError>>({ code: 'PARSER_ERROR' }),
    )
  })
})

describe('parseFilmsPage', () => {
  it('extracts a public watched-films page and its pagination', async () => {
    const html = await fixture('films-page.html')

    expect(parseFilmsPage(html)).toEqual([
      { title: 'Arrival', year: 2016, slug: 'arrival-2016' },
      { title: 'Shōgun', year: 2024, slug: 'shogun-2024' },
    ])
    expect(hasNextFilmsPage(html, 2)).toBe(true)
    expect(hasNextFilmsPage(html, 3)).toBe(false)
  })
})
