import { describe, expect, it, vi } from 'vitest'
import { fetchWatchlist } from '../src/letterboxd'

const page = (film: string, slug: string, year: number, next?: number) => `
  <html><head><title>Test Watchlist</title></head><body>
    <ul class="poster-list">
      <li><div data-item-name="${film} (${year})" data-item-slug="${slug}" data-item-link="/film/${slug}/"></div></li>
    </ul>
    ${next ? `<a class="next" href="/test/watchlist/page/${next}/">Older</a>` : ''}
  </body></html>`

describe('fetchWatchlist', () => {
  it('loads pages sequentially and deduplicates while preserving order', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(page('First', 'first', 2024, 2)))
      .mockResolvedValueOnce(
        new Response(`
          <html><head><title>Test Watchlist</title></head><body>
            <ul class="poster-list">
              <li><div data-item-name="First (2024)" data-item-slug="first"></div></li>
              <li><div data-item-name="Second (2023)" data-item-slug="second"></div></li>
            </ul>
          </body></html>`),
      )

    await expect(fetchWatchlist('test', fetcher)).resolves.toEqual([
      { title: 'First', year: 2024, slug: 'first' },
      { title: 'Second', year: 2023, slug: 'second' },
    ])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('maps 403 to LETTERBOXD_BLOCKED', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 }))

    await expect(fetchWatchlist('test', fetcher)).rejects.toMatchObject({
      code: 'LETTERBOXD_BLOCKED',
      status: 502,
    })
  })

  it('distinguishes a missing user from an unavailable watchlist', async () => {
    const missingUser = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))

    await expect(fetchWatchlist('missing', missingUser)).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
      status: 404,
    })

    const privateWatchlist = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('<html>profile</html>', { status: 200 }))

    await expect(fetchWatchlist('private', privateWatchlist)).rejects.toMatchObject({
      code: 'WATCHLIST_UNAVAILABLE',
      status: 404,
    })
  })
})
