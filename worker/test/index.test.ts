import { describe, expect, it } from 'vitest'
import { handleRequest } from '../src/index'

describe('Worker endpoint', () => {
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
})
