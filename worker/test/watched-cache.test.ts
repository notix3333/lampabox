import { describe, expect, it, vi } from 'vitest'
import { AppError, type LetterboxdFilm } from '../src/types'
import {
  collectNextWatchedProfile,
  collectWatchedProfile,
  readWatchedResponse,
  registerWatchedProfile,
  seedAndReadWatchedResponse,
  type WatchedCacheBinding,
} from '../src/watched-cache'

class MemoryKv implements WatchedCacheBinding {
  readonly values = new Map<string, string>()

  async get(key: string, type: 'json'): Promise<unknown> {
    if (type !== 'json') throw new Error('Unexpected KV type')
    const value = this.values.get(key)
    return value ? JSON.parse(value) : null
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async list(options: { prefix?: string } = {}) {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(options.prefix || ''))
      .sort()
      .map((name) => ({ name }))

    return { keys, list_complete: true }
  }
}

const film = (slug: string): LetterboxdFilm => ({
  title: slug.toUpperCase(),
  year: 2026,
  slug,
})

describe('background watched cache', () => {
  it('seeds page one, exposes partial data, and atomically completes the crawl', async () => {
    const kv = new MemoryKv()
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ films: [film('one')], nextPage: 2, total: 2 })
      .mockResolvedValueOnce({ films: [film('two')], nextPage: null, total: null })

    const first = await seedAndReadWatchedResponse(kv, 'Alice', 1, {
      now: 1_000,
      random: () => 0,
      fetchPage,
    })

    expect(first.films).toEqual([film('one')])
    expect(first.cache).toMatchObject({
      status: 'building',
      collectedFilms: 1,
      sourcePages: 1,
      nextSourcePage: 2,
    })

    await collectWatchedProfile(kv, 'Alice', {
      now: 31_001,
      random: () => 0,
      fetchPage,
    })

    const completed = await readWatchedResponse(kv, 'Alice', 1)
    expect(completed?.films).toEqual([film('one'), film('two')])
    expect(completed?.total).toBe(2)
    expect(completed?.cache).toMatchObject({
      status: 'complete',
      collectedFilms: 2,
      sourcePages: null,
      nextSourcePage: 1,
    })
  })

  it('keeps the last complete snapshot when a refresh is blocked', async () => {
    const kv = new MemoryKv()
    const successfulFetch = vi.fn().mockResolvedValue({
      films: [film('safe')],
      nextPage: null,
      total: 1,
    })

    await collectWatchedProfile(kv, 'alice', {
      now: 1_000,
      random: () => 0,
      fetchPage: successfulFetch,
    })

    const blockedFetch = vi
      .fn()
      .mockRejectedValue(new AppError('LETTERBOXD_BLOCKED', 'Letterboxd blocked', 502))

    await expect(
      collectWatchedProfile(kv, 'alice', {
        now: 12 * 60 * 60 * 1000 + 1_001,
        random: () => 0,
        fetchPage: blockedFetch,
      }),
    ).rejects.toMatchObject({ code: 'LETTERBOXD_BLOCKED' })

    const cached = await readWatchedResponse(kv, 'alice', 1)
    expect(cached?.films).toEqual([film('safe')])
    expect(cached?.cache).toMatchObject({ status: 'complete' })
    expect(cached?.cache?.lastFailureAt).not.toBeNull()
  })

  it('applies backoff with jitter and skips a profile until it is due', async () => {
    const kv = new MemoryKv()
    await registerWatchedProfile(kv, 'alice', 1_000)
    const fetchPage = vi.fn().mockRejectedValue(new Error('temporary network error'))

    await expect(
      collectWatchedProfile(kv, 'alice', {
        now: 1_000,
        random: () => 0.5,
        fetchPage,
      }),
    ).rejects.toThrow('temporary network error')

    await expect(
      collectNextWatchedProfile(kv, {
        now: 1_000 + 5 * 60 * 1000,
        random: () => 0,
        fetchPage,
      }),
    ).resolves.toBeNull()
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('fetches exactly one source page per scheduled collection run', async () => {
    const kv = new MemoryKv()
    await registerWatchedProfile(kv, 'alice', 1_000)
    await registerWatchedProfile(kv, 'bob', 1_000)
    const fetchPage = vi.fn().mockResolvedValue({
      films: [film('one')],
      nextPage: 2,
      total: 2,
    })

    await collectNextWatchedProfile(kv, {
      now: 2_000,
      random: () => 0,
      fetchPage,
    })

    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(fetchPage).toHaveBeenCalledWith('alice', 1)
  })

  it('paginates a cached snapshot independently from Letterboxd pages', async () => {
    const kv = new MemoryKv()
    const films = Array.from({ length: 101 }, (_, index) => film(`film-${index}`))

    await collectWatchedProfile(kv, 'alice', {
      now: 1_000,
      random: () => 0,
      fetchPage: vi.fn().mockResolvedValue({ films, nextPage: null, total: 101 }),
    })

    const first = await readWatchedResponse(kv, 'alice', 1)
    const second = await readWatchedResponse(kv, 'alice', 2)
    expect(first?.films).toHaveLength(100)
    expect(first?.nextPage).toBe(2)
    expect(second?.films).toHaveLength(1)
    expect(second?.nextPage).toBeNull()
  })
})
