const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createTaskLimiter,
  filterCatalogMovies,
  isWatchedInLampa,
  mapWithConcurrency,
  normalizeTitle,
  parseListEntries,
  pickBestTmdbResult,
  retryWithBackoff,
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

test('pickBestTmdbResult supports TMDB TV fields', () => {
  const result = pickBestTmdbResult(
    { title: 'Shōgun', year: 2024 },
    [],
    [{ id: 5, name: 'Shōgun', original_name: 'Shōgun', first_air_date: '2024-02-27' }],
  )

  assert.equal(result.id, 5)
  assert.equal(result.media_type, 'tv')
  assert.equal(result.source, 'tmdb')
})

test('parseListEntries accepts slugs, owner paths and public URLs', () => {
  assert.deepEqual(
    parseListEntries(
      'favorites, bob/tv-picks, https://letterboxd.com/alice/list/top-films/, BOB/tv-picks',
      'nikolai',
    ),
    [
      { username: 'nikolai', slug: 'favorites', key: 'nikolai/favorites' },
      { username: 'bob', slug: 'tv-picks', key: 'bob/tv-picks' },
      { username: 'alice', slug: 'top-films', key: 'alice/top-films' },
    ],
  )

  assert.deepEqual(parseListEntries('nikolai', 'nikolai'), [])
})

test('retryWithBackoff retries failures with the declared delays', async () => {
  let attempts = 0
  const sleeps = []
  const value = await retryWithBackoff(
    async () => {
      attempts += 1
      if (attempts < 3) throw new Error('temporary')
      return 'ok'
    },
    [200, 400],
    async (delay) => sleeps.push(delay),
  )

  assert.equal(value, 'ok')
  assert.equal(attempts, 3)
  assert.deepEqual(sleeps, [200, 400])
})

test('createTaskLimiter enforces one shared concurrency limit', async () => {
  const run = createTaskLimiter(2)
  let active = 0
  let maximum = 0
  const values = await Promise.all(
    [20, 10, 5, 1].map((delay) =>
      run(async () => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, delay))
        active -= 1
        return delay
      }),
    ),
  )

  assert.deepEqual(values, [20, 10, 5, 1])
  assert.equal(maximum, 2)
})

test('isWatchedInLampa accepts an explicit mark or completed playback', () => {
  const marked = {
    Favorite: { check: () => ({ viewed: true }) },
    Timeline: { watched: () => ({ percent: 0 }) },
  }
  const completed = {
    Favorite: { check: () => ({}) },
    Timeline: { watched: () => ({ percent: 95 }) },
  }

  assert.equal(isWatchedInLampa({ original_title: 'Arrival' }, marked), true)
  assert.equal(isWatchedInLampa({ original_title: 'Arrival' }, completed), true)
})

test('filterCatalogMovies exposes only all, watched and unwatched modes', () => {
  const movies = [
    { id: 1, letterboxd_watched: true, lampa_watched: false },
    { id: 2, letterboxd_watched: false, lampa_watched: true },
    { id: 3, letterboxd_watched: false, lampa_watched: false },
  ]

  assert.deepEqual(filterCatalogMovies(movies, 'watched').map((movie) => movie.id), [1, 2])
  assert.deepEqual(filterCatalogMovies(movies, 'unwatched').map((movie) => movie.id), [3])
  assert.deepEqual(filterCatalogMovies(movies, 'all').map((movie) => movie.id), [1, 2, 3])
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
  const requestUrls = []
  const registeredComponents = []
  const menuButtons = []
  const activities = []
  const replacements = []
  const selections = []

  delete require.cache[pluginPath]
  delete global.plugin_letterboxd_watchlist_ready
  global.appready = true
  global.Lampa = {
    Api: { search: () => {} },
    Activity: {
      push: (activity) => activities.push(activity),
      replace: (activity) => replacements.push(activity),
    },
    Background: { change: () => {} },
    Component: {
      add: (name, constructor) => registeredComponents.push({ name, constructor }),
    },
    ContentRows: { add: (row) => rows.push(row) },
    InteractionMain: function () {},
    Listener: { follow: () => {}, remove: () => {} },
    Menu: {
      addButton: (_icon, title, action) => {
        menuButtons.push({ title, action })
        return { attr: () => {} }
      },
    },
    Noty: { show: () => {} },
    Router: { call: () => {} },
    Select: { show: (selection) => selections.push(selection) },
    Controller: { toggle: () => {} },
    Reguest: class {
      timeout() {}
      native(url, resolve) {
        requestUrls.push(url)
        resolve({ version: 1, films: [] })
      }
    },
    SettingsApi: {
      addComponent: (component) => components.push(component),
      addParam: (param) => {
        if (param.param.type === 'input') assert.equal(param.param.values, '')
        params.push(param)
      },
    },
    Storage: {
      get: (name, fallback) => {
        if (name === 'letterboxd_watchlist_username') return 'example'
        if (name === 'letterboxd_watchlist_api_url') return 'https://worker.example'
        return fallback
      },
    },
    Utils: { createInstance: () => null },
  }

  require(pluginPath)
  const rowLoader = rows[0].call()
  rowLoader(() => {})
  rowLoader(() => {})
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(components.length, 1)
  assert.equal(params.length, 3)
  assert.equal(rows.length, 1)
  assert.deepEqual(requestUrls.sort(), [
    'https://worker.example/watched/example?page=1',
    'https://worker.example/watchlist/example',
  ])
  assert.equal(registeredComponents[0].name, 'letterboxd_catalog')
  assert.equal(menuButtons[0].title, 'Letterboxd')

  menuButtons[0].action()
  assert.deepEqual(activities[0], {
    component: 'letterboxd_catalog',
    title: 'Letterboxd',
    filter: 'all',
    page: 1,
  })

  let catalogLines
  const fakeComponent = {
    activity: { loader: () => {} },
    build: (lines) => {
      catalogLines = lines
    },
  }
  global.Lampa.Utils.createInstance = () => fakeComponent
  const catalog = registeredComponents[0].constructor({ filter: 'all' })
  assert.equal(typeof catalog.use, 'undefined')
  assert.equal(typeof catalog.create, 'function')
  catalog.create()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(catalogLines[0].title, 'Фильтр и статусы')
  assert.equal(catalogLines[0].wide, undefined)
  assert.equal(catalogLines[0].results[0].letterboxd_control, 'filter')

  const filterLine = {}
  catalog.onAppend(filterLine)
  filterLine.onSelect(null, catalogLines[0].results[0])
  assert.deepEqual(
    selections[0].items.map((item) => item.value),
    ['all', 'watched', 'unwatched'],
  )
  selections[0].onSelect({ value: 'watched' })
  assert.deepEqual(replacements[0], { filter: 'watched' })

  delete require.cache[pluginPath]
  delete global.plugin_letterboxd_watchlist_ready
  delete global.appready
  delete global.Lampa
})

test('Lampa integration appends TMDB matches to an already visible row', async () => {
  const pluginPath = require.resolve('../letterboxd-watchlist.js')
  const rows = []
  let lineListener

  delete require.cache[pluginPath]
  delete global.plugin_letterboxd_watchlist_ready
  global.appready = true
  global.Lampa = {
    Api: {
      search: ({ query }, callback) => {
        const delay = query === 'First' ? 0 : 30
        setTimeout(
          () =>
            callback({
              movie: {
                results: [
                  {
                    id: query === 'First' ? 1 : 2,
                    title: query,
                    original_title: query,
                    release_date: '2024-01-01',
                  },
                ],
              },
              tv: { results: [] },
            }),
          delay,
        )
      },
    },
    ContentRows: { add: (row) => rows.push(row) },
    Listener: {
      follow: (name, listener) => {
        if (name === 'line') lineListener = listener
      },
    },
    Noty: { show: () => {} },
    Reguest: class {
      timeout() {}
      native(_url, resolve) {
        resolve({
          version: 1,
          title: 'Progressive list',
          films: [
            { title: 'First', year: 2024, slug: 'first' },
            { title: 'Second', year: 2024, slug: 'second' },
          ],
        })
      }
    },
    SettingsApi: { addComponent: () => {}, addParam: () => {} },
    Storage: {
      get: (name, fallback) => {
        if (name === 'letterboxd_watchlist_username') return 'example'
        if (name === 'letterboxd_public_lists') return ''
        if (name === 'letterboxd_watchlist_api_url') return 'https://worker.example'
        return fallback
      },
    },
  }

  require(pluginPath)
  const rowLoader = rows[0].call()
  const line = await new Promise((resolve) => {
    rowLoader((data) => {
      assert.equal(data.results.length, 1)
      const visibleLine = {
        items: data.results.slice(),
        emit: function (_type, movie) {
          this.items.push(movie)
        },
      }
      lineListener({ type: 'create', data, line: visibleLine, items: visibleLine.items })
      resolve(visibleLine)
    })
  })

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.deepEqual(
    line.items.map((item) => item.id),
    [1, 2],
  )

  delete require.cache[pluginPath]
  delete global.plugin_letterboxd_watchlist_ready
  delete global.appready
  delete global.Lampa
})

test('watched filter builds the complete Letterboxd catalog plus Lampa viewed items', async () => {
  const pluginPath = require.resolve('../letterboxd-watchlist.js')
  const registeredComponents = []
  let catalogLines

  delete require.cache[pluginPath]
  delete global.plugin_letterboxd_watchlist_ready
  global.appready = true
  global.Lampa = {
    Api: {
      search: (_query, callback) => {
        callback({
          movie: {
            results: [
              {
                id: 42,
                title: 'Arrival',
                original_title: 'Arrival',
                release_date: '2016-11-11',
              },
            ],
          },
          tv: { results: [] },
        })
      },
    },
    Activity: { push: () => {}, replace: () => {} },
    Component: {
      add: (name, constructor) => registeredComponents.push({ name, constructor }),
    },
    ContentRows: { add: () => {} },
    Favorite: {
      check: (movie) => ({ viewed: movie.id === 7 }),
      get: () => [
        {
          id: 7,
          title: 'Lampa movie',
          original_title: 'Lampa movie',
          release_date: '2020-01-01',
        },
      ],
    },
    InteractionMain: function () {},
    Listener: { follow: () => {}, remove: () => {} },
    Menu: { addButton: () => ({ attr: () => {} }) },
    Noty: { show: () => {} },
    Reguest: class {
      timeout() {}
      native(url, resolve) {
        if (url.includes('/watched/')) {
          resolve({
            version: 1,
            films: [{ title: 'Arrival', year: 2016, slug: 'arrival-2016' }],
            nextPage: null,
          })
          return
        }
        resolve({ version: 1, films: [] })
      }
    },
    SettingsApi: { addComponent: () => {}, addParam: () => {} },
    Storage: {
      get: (name, fallback) => {
        if (name === 'letterboxd_watchlist_username') return 'alice'
        if (name === 'letterboxd_public_lists') return ''
        if (name === 'letterboxd_watchlist_api_url') return 'https://worker.example'
        return fallback
      },
    },
    Timeline: { watched: () => null },
    Utils: {
      createInstance: () => ({
        activity: { loader: () => {} },
        build: (lines) => {
          catalogLines = lines
        },
      }),
    },
  }

  require(pluginPath)
  const catalog = registeredComponents[0].constructor({ filter: 'watched' })
  catalog.create()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(catalogLines.length, 3)
  assert.equal(catalogLines[1].title, 'Просмотрено в Letterboxd · 1/1')
  assert.equal(catalogLines[1].results[0].id, 42)
  assert.equal(catalogLines[1].results[0].letterboxd_watched, true)
  assert.equal(catalogLines[2].title, 'Просмотрено в Lampa · 1')
  assert.equal(catalogLines[2].results[0].id, 7)

  delete require.cache[pluginPath]
  delete global.plugin_letterboxd_watchlist_ready
  delete global.appready
  delete global.Lampa
})
