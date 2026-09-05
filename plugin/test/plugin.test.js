const test = require('node:test')
const assert = require('node:assert/strict')
const {
  mapWithConcurrency,
  normalizeTitle,
  pickBestTmdbResult,
} = require('../letterboxd-watchlist.js')

test('normalizeTitle normalizes Unicode and whitespace', () => {
  assert.equal(normalizeTitle('  DUNE:\u00a0 Part   Two  '), 'dune: part two')
})

test('pickBestTmdbResult prefers exact localized title and year', () => {
  const result = pickBestTmdbResult(
    { title: 'Anora', year: 2024 },
    [
      { id: 1, title: 'Anora', original_title: 'Anora', release_date: '2023-12-01' },
      { id: 2, title: 'Anora', original_title: 'Anora', release_date: '2024-10-14' },
    ],
  )

  assert.equal(result.id, 2)
  assert.equal(result.source, 'tmdb')
})

test('pickBestTmdbResult accepts an exact original title and year', () => {
  const result = pickBestTmdbResult(
    { title: 'La haine', year: 1995 },
    [{ id: 3, title: 'Hate', original_title: 'La Haine', release_date: '1995-05-31' }],
  )

  assert.equal(result.id, 3)
})

test('pickBestTmdbResult skips unsafe matches', () => {
  const result = pickBestTmdbResult(
    { title: 'Moving', year: 2023 },
    [{ id: 4, title: 'Moving', original_title: 'Moving', release_date: '2019-01-01' }],
  )

  assert.equal(result, null)
})

test('mapWithConcurrency keeps result order and respects the limit', async () => {
  let active = 0
  let maximum = 0
  const result = await mapWithConcurrency([30, 10, 20, 5], 2, async (delay) => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, delay))
    active -= 1
    return delay
  })

  assert.deepEqual(result, [30, 10, 20, 5])
  assert.equal(maximum, 2)
})

test('Lampa integration registers settings and loads the Worker only once per session', async () => {
  const pluginPath = require.resolve('../letterboxd-watchlist.js')
  const components = []
  const params = []
  const rows = []
  let requests = 0

  delete require.cache[pluginPath]
  delete global.plugin_letterboxd_watchlist_ready
  global.appready = true
  global.Lampa = {
    Api: { search: () => {} },
    ContentRows: { add: (row) => rows.push(row) },
    Listener: { follow: () => {} },
    Noty: { show: () => {} },
    Reguest: class {
      timeout() {}
      native(_url, resolve) {
        requests += 1
        resolve({ version: 1, films: [] })
      }
    },
    SettingsApi: {
      addComponent: (component) => components.push(component),
      addParam: (param) => params.push(param),
    },
    Storage: {
      get: (name, fallback) => {
        if (name === 'letterboxd_watchlist_username') return 'example'
        if (name === 'letterboxd_watchlist_api_url') return 'https://worker.example'
        return fallback
      },
    },
  }

  require(pluginPath)
  const rowLoader = rows[0].call()
  rowLoader(() => {})
  rowLoader(() => {})
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(components.length, 1)
  assert.equal(params.length, 2)
  assert.equal(rows.length, 1)
  assert.equal(requests, 1)

  delete require.cache[pluginPath]
  delete global.plugin_letterboxd_watchlist_ready
  delete global.appready
  delete global.Lampa
})
