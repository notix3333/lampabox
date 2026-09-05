import { describe, expect, it, vi } from 'vitest'
import { fetchPublicList, fetchWatchlist } from '../src/letterboxd'

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

  it('retries temporary upstream errors with short backoff', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(page('Recovered', 'recovered', 2025)))
    const sleeper = vi.fn(async () => undefined)

    await expect(fetchWatchlist('test', fetcher, sleeper)).resolves.toEqual([
      { title: 'Recovered', year: 2025, slug: 'recovered' },
    ])
    expect(sleeper).toHaveBeenNthCalledWith(1, 250)
    expect(sleeper).toHaveBeenNthCalledWith(2, 500)
  })

  it('loads a public list and returns its title', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(`
        <html><head><meta property="og:title" content="TV picks"></head>
          <body data-list-name="TV picks">
            <div data-item-name="Shōgun (2024)" data-item-slug="shogun-2024"></div>
          </body>
        </html>`),
    )

    await expect(fetchPublicList('alice', 'tv-picks', fetcher)).resolves.toEqual({
      title: 'TV picks',
      films: [{ title: 'Shōgun', year: 2024, slug: 'shogun-2024' }],
    })
    expect(fetcher.mock.calls[0][0]).toBe('https://letterboxd.com/alice/list/tv-picks/')
  })

  it('does not mistake Letterboxd privacy controls embedded in a public list for an error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(`
        <html><head><meta property="og:title" content="Public"></head>
          <body data-list-name="Public">
            <script>const option = 'You (private list)'</script>
            <div data-item-name="Anora (2024)" data-item-slug="anora"></div>
          </body>
        </html>`),
    )

    await expect(fetchPublicList('alice', 'public', fetcher)).resolves.toMatchObject({
      films: [{ title: 'Anora', year: 2024, slug: 'anora' }],
    })
  })
})
