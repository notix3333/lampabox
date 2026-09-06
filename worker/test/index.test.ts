import { describe, expect, it } from 'vitest'
import { handleRequest } from '../src/index'

describe('Worker endpoint', () => {
  it('serves the curated list preset catalog', async () => {
    const response = await handleRequest(new Request('https://worker.example/presets'))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      version: 1,
      source: 'https://letterboxd.com/lists/popular/',
    })
    expect(payload.lists).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          username: 'official',
          slug: 'letterboxds-top-500-films',
        }),
      ]),
    )
  })

  it('serves a valid preset catalog override from the existing KV binding', async () => {
    const override = {
      version: 1,
      updatedAt: '2026-09-06T12:00:00.000Z',
      source: 'https://letterboxd.com/lists/popular/',
      lists: [
        {
          id: 'test-list',
          title: 'Test List',
          description: 'Updated without rebuilding the plugin.',
          username: 'official',
          slug: 'test-list',
        },
      ],
    }
    const response = await handleRequest(new Request('https://worker.example/presets'), {
      WATCHED_CACHE: {
        get: async () => override,
        put: async () => undefined,
        list: async () => ({ keys: [], list_complete: true }),
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(override)
  })

  it('falls back to the built-in catalog when a KV override is invalid', async () => {
    const response = await handleRequest(new Request('https://worker.example/presets'), {
      WATCHED_CACHE: {
        get: async () => ({ version: 1, lists: [] }),
        put: async () => undefined,
        list: async () => ({ keys: [], list_complete: true }),
      },
    })

    const payload = await response.json()
    expect(payload.lists.length).toBeGreaterThan(1)
    expect(payload.lists[0]).toMatchObject({ id: 'official-top-500' })
  })

  it('rejects paths and usernames outside the fixed endpoint', async () => {
    const response = await handleRequest(
      new Request('https://worker.example/watchlist/not%2Fa%2Fusername'),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'INVALID_USERNAME',
        message: 'Letterboxd username is invalid',
      },
    })
  })

  it('answers CORS preflight without caching', async () => {
    const response = await handleRequest(
      new Request('https://worker.example/watchlist/test', { method: 'OPTIONS' }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects unsafe list slugs on the fixed list endpoint', async () => {
    const response = await handleRequest(
      new Request('https://worker.example/list/test/not%2Fa%2Fslug'),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_LIST' },
    })
  })

  it('rejects unsafe usernames on the watched endpoint', async () => {
    const response = await handleRequest(
      new Request('https://worker.example/watched/not%2Fa%2Fusername'),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_USERNAME' },
    })
  })

  it('rejects unbounded watched-page requests', async () => {
    const response = await handleRequest(
      new Request('https://worker.example/watched/test?page=101'),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_PAGE' },
    })
  })
})
