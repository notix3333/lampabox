import { DomUtils, parseDocument } from 'htmlparser2'
import type { AnyNode, Element } from 'domhandler'
import { AppError, type LetterboxdFilm } from './types'

const FILM_PATH = /^\/film\/([a-z0-9][a-z0-9-]*)\/?$/i
const DISPLAY_NAME = /^(.*?)\s+\(((?:18|19|20|21)\d{2})\)$/u

function isElement(node: AnyNode): node is Element {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style'
}

function parseDisplayName(value: string): { title: string; year: number | null } {
  const text = value.trim()
  const match = text.match(DISPLAY_NAME)

  if (!match) return { title: text, year: null }

  return {
    title: match[1].trim(),
    year: Number(match[2]),
  }
}

function slugFromElement(element: Element): string | null {
  const directSlug = element.attribs['data-item-slug']

  if (directSlug && /^[a-z0-9][a-z0-9-]*$/i.test(directSlug)) return directSlug

  const link = element.attribs['data-item-link'] || element.attribs.href || ''
  const match = link.match(FILM_PATH)

  return match ? match[1] : null
}

function semanticFilms(html: string): LetterboxdFilm[] {
  const document = parseDocument(html)
  const elements = DomUtils.findAll(
    (node) => isElement(node) && Boolean(node.attribs['data-item-slug'] || node.attribs['data-item-link']),
    document.children,
  )

  return elements.flatMap((element) => {
    const slug = slugFromElement(element)
    const displayName =
      element.attribs['data-item-full-display-name'] || element.attribs['data-item-name']

    if (!slug || !displayName) return []

    const { title, year } = parseDisplayName(displayName)

    return title ? [{ title, year, slug }] : []
  })
}

function fallbackFilms(html: string): LetterboxdFilm[] {
  const document = parseDocument(html)
  const links = DomUtils.findAll(
    (node) => isElement(node) && node.name === 'a' && FILM_PATH.test(node.attribs.href || ''),
    document.children,
  )

  return links.flatMap((link) => {
    const slug = slugFromElement(link)
    const image = DomUtils.findOne(
      (node) => isElement(node) && node.name === 'img' && Boolean(node.attribs.alt),
      link.children,
    )
    const displayName = link.attribs.title || (image && isElement(image) ? image.attribs.alt : '')

    if (!slug || !displayName) return []

    const { title, year } = parseDisplayName(displayName)

    return title ? [{ title, year, slug }] : []
  })
}

function deduplicate(films: LetterboxdFilm[]): LetterboxdFilm[] {
  const seen = new Set<string>()

  return films.filter((film) => {
    if (seen.has(film.slug)) return false

    seen.add(film.slug)
    return true
  })
}

function looksLikeWatchlist(html: string): boolean {
  const normalized = html.toLowerCase()

  return (
    normalized.includes('watchlist') &&
    (normalized.includes('data-item-slug') ||
      normalized.includes('poster-list') ||
      normalized.includes('no films yet') ||
      normalized.includes('wants to see 0'))
  )
}

function looksLikeList(html: string): boolean {
  const normalized = html.toLowerCase()

  return (
    normalized.includes('data-list-name') ||
    normalized.includes('numbered-list-item') ||
    normalized.includes('this list is empty')
  )
}

function nextPageLink(html: string, expectedSuffix: string): boolean {
  const document = parseDocument(html)

  return Boolean(
    DomUtils.findOne(
      (node) => {
        if (!isElement(node) || node.name !== 'a') return false

        const classNames = (node.attribs.class || '').split(/\s+/)
        const href = node.attribs.href || ''

        return classNames.includes('next') && href.endsWith(expectedSuffix)
      },
      document.children,
    ),
  )
}

export function parseWatchlistPage(html: string): LetterboxdFilm[] {
  if (!html.trim() || !looksLikeWatchlist(html)) {
    throw new AppError('PARSER_ERROR', 'Letterboxd returned an unrecognized watchlist page', 500)
  }

  const semantic = semanticFilms(html)
  return deduplicate(semantic.length ? semantic : fallbackFilms(html))
}

export function hasNextWatchlistPage(html: string, nextPage: number): boolean {
  return nextPageLink(html, `/watchlist/page/${nextPage}/`)
}

export function parseListPage(html: string): LetterboxdFilm[] {
  if (!html.trim() || !looksLikeList(html)) {
    throw new AppError('PARSER_ERROR', 'Letterboxd returned an unrecognized list page', 500)
  }

  const semantic = semanticFilms(html)
  return deduplicate(semantic.length ? semantic : fallbackFilms(html))
}

export function parseListTitle(html: string): string | null {
  const document = parseDocument(html)
  const meta = DomUtils.findOne(
    (node) =>
      isElement(node) &&
      node.name === 'meta' &&
      node.attribs.property === 'og:title' &&
      Boolean(node.attribs.content),
    document.children,
  )

  if (meta && isElement(meta)) return meta.attribs.content.trim() || null

  const heading = DomUtils.findOne(
    (node) => {
      if (!isElement(node) || node.name !== 'h1') return false
      return (node.attribs.class || '').split(/\s+/).includes('title-1')
    },
    document.children,
  )

  return heading && isElement(heading) ? DomUtils.textContent(heading).trim() || null : null
}

export function hasNextListPage(html: string, slug: string, nextPage: number): boolean {
  return nextPageLink(html, `/list/${slug}/page/${nextPage}/`)
}
