(function (global) {
  'use strict'

  const PLUGIN_NAME = 'Letterboxd Watchlist'
  const PLUGIN_VERSION = '1.0.0'
  const STORAGE_USERNAME = 'letterboxd_watchlist_username'
  const STORAGE_API_URL = 'letterboxd_watchlist_api_url'
  const API_BASE_URL = 'https://example.workers.dev'
  const MAX_TMDB_CONCURRENCY = 5
  const ROW_NAME = 'letterboxd_watchlist'

  let sessionWatchlistPromise = null
  let errorShown = false

  function log() {
    const args = Array.prototype.slice.call(arguments)
    args.unshift(`[${PLUGIN_NAME}]`)
    console.log.apply(console, args)
  }

  function normalizeTitle(title) {
    return String(title || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
  }

  function releaseYear(movie) {
    const value = movie && movie.release_date
    const match = typeof value === 'string' ? value.match(/^(\d{4})/) : null
    return match ? Number(match[1]) : null
  }

  function pickBestTmdbResult(film, results) {
    if (!film || !film.year || !Array.isArray(results)) return null

    const wantedTitle = normalizeTitle(film.title)
    const candidates = results.filter(function (movie) {
      return movie && movie.id && releaseYear(movie) !== null
    })

    const rules = [
      function (movie) {
        return normalizeTitle(movie.title) === wantedTitle && releaseYear(movie) === film.year
      },
      function (movie) {
        return normalizeTitle(movie.original_title) === wantedTitle && releaseYear(movie) === film.year
      },
      function (movie) {
        return (
          normalizeTitle(movie.title) === wantedTitle &&
          Math.abs(releaseYear(movie) - film.year) <= 1
        )
      },
    ]

    for (let index = 0; index < rules.length; index += 1) {
      const match = candidates.find(rules[index])
      if (match) return Object.assign({}, match, { source: 'tmdb' })
    }

    return null
  }

  function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length)
    let nextIndex = 0

    function worker() {
      const index = nextIndex
      nextIndex += 1

      if (index >= items.length) return Promise.resolve()

      return Promise.resolve(mapper(items[index], index))
        .then(function (value) {
          results[index] = value
        })
        .catch(function (error) {
          log('TMDB lookup failed:', error && error.message ? error.message : error)
          results[index] = null
        })
        .then(worker)
    }

    const workers = []
    const workerCount = Math.min(Math.max(1, limit), items.length)

    for (let index = 0; index < workerCount; index += 1) workers.push(worker())

    return Promise.all(workers).then(function () {
      return results
    })
  }

  function searchTmdb(film) {
    return new Promise(function (resolve) {
      global.Lampa.Api.search({ query: film.title }, function (result) {
        const movies = result && result.movie && Array.isArray(result.movie.results)
          ? result.movie.results
          : []

        resolve(pickBestTmdbResult(film, movies))
      })
    })
  }

  function workerError(error) {
    const payload = error && error.responseJSON && error.responseJSON.error
    return payload && payload.code ? payload : null
  }

  function configuredApiBaseUrl() {
    return String(global.Lampa.Storage.get(STORAGE_API_URL, API_BASE_URL) || '')
      .trim()
      .replace(/\/+$/, '')
  }

  function requestWatchlist(username, apiBaseUrl) {
    return new Promise(function (resolve, reject) {
      const network = new global.Lampa.Reguest()
      const url = `${apiBaseUrl}/watchlist/${encodeURIComponent(username)}`

      network.timeout(30000)
      network.native(url, resolve, reject)
    })
  }

  function notificationFor(error) {
    const details = workerError(error)

    if (details && details.code === 'USER_NOT_FOUND') return 'Letterboxd: пользователь не найден'
    if (details && details.code === 'INVALID_USERNAME') return 'Letterboxd: некорректный username'
    if (details && details.code === 'LETTERBOXD_BLOCKED') return 'Letterboxd временно блокирует запросы'
    if (details && details.code === 'WATCHLIST_UNAVAILABLE') {
      return 'Не удалось получить Letterboxd Watchlist. Проверьте username и доступность watchlist.'
    }

    return 'Letterboxd Watchlist временно недоступен'
  }

  function notifyOnce(message) {
    if (errorShown) return

    errorShown = true
    global.Lampa.Noty.show(message)
  }

  function loadSessionWatchlist() {
    const username = String(global.Lampa.Storage.get(STORAGE_USERNAME, '') || '').trim()
    const apiBaseUrl = configuredApiBaseUrl()

    if (!username) return Promise.resolve([])

    log('username:', username)

    if (!/^https?:\/\/[^\s]+$/i.test(apiBaseUrl)) {
      const error = new Error('Worker URL is invalid')
      log('error:', error.message)
      notifyOnce('Letterboxd Watchlist: указан некорректный адрес Worker')
      return Promise.resolve([])
    }

    if (apiBaseUrl === 'https://example.workers.dev') {
      const error = new Error('API_BASE_URL is not configured')
      log('error:', error.message)
      notifyOnce('Letterboxd Watchlist: настройте адрес Worker в плагине')
      return Promise.resolve([])
    }

    return requestWatchlist(username, apiBaseUrl)
      .then(function (payload) {
        if (!payload || payload.version !== 1 || !Array.isArray(payload.films)) {
          throw new Error('Worker returned an invalid response')
        }

        log('watchlist received:', payload.films.length)

        return mapWithConcurrency(payload.films, MAX_TMDB_CONCURRENCY, searchTmdb).then(
          function (matches) {
            const resolved = matches.filter(Boolean)
            log(`TMDB matched: ${resolved.length}/${payload.films.length}`)
            return resolved
          },
        )
      })
      .catch(function (error) {
        log('error:', error)
        notifyOnce(notificationFor(error))
        return []
      })
  }

  function ensureSessionWatchlist() {
    if (!sessionWatchlistPromise) sessionWatchlistPromise = loadSessionWatchlist()
    return sessionWatchlistPromise
  }

  function registerSettings() {
    global.Lampa.SettingsApi.addComponent({
      component: 'letterboxd',
      name: 'Letterboxd',
      icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="32" r="12" fill="#00e054"/><circle cx="32" cy="32" r="12" fill="#40bcf4"/><circle cx="48" cy="32" r="12" fill="#ff8000"/></svg>',
    })

    global.Lampa.SettingsApi.addParam({
      component: 'letterboxd',
      param: {
        name: STORAGE_USERNAME,
        type: 'input',
        default: '',
        placeholder: 'username',
      },
      field: {
        name: 'Letterboxd username',
        description: 'Публичный username. Изменения применятся после перезапуска Lampa.',
      },
    })

    global.Lampa.SettingsApi.addParam({
      component: 'letterboxd',
      param: {
        name: STORAGE_API_URL,
        type: 'input',
        default: API_BASE_URL,
        placeholder: 'https://name.workers.dev',
      },
      field: {
        name: 'Worker URL',
        description: 'Адрес развернутого Cloudflare Worker. Изменения применятся после перезапуска.',
      },
    })
  }

  function registerContentRow() {
    global.Lampa.ContentRows.add({
      name: ROW_NAME,
      title: PLUGIN_NAME,
      screen: ['main'],
      call: function () {
        const username = String(global.Lampa.Storage.get(STORAGE_USERNAME, '') || '').trim()
        if (!username) return

        return function (call) {
          ensureSessionWatchlist().then(function (movies) {
            call({
              title: PLUGIN_NAME,
              results: movies,
              total_pages: 1,
              nomore: true,
            })
          })
        }
      },
    })
  }

  function init() {
    if (global.plugin_letterboxd_watchlist_ready) return

    global.plugin_letterboxd_watchlist_ready = true
    registerSettings()
    registerContentRow()
    ensureSessionWatchlist()
    log('plugin initialized', PLUGIN_VERSION)
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeTitle, pickBestTmdbResult, mapWithConcurrency }
  }

  if (global.Lampa) {
    if (global.appready) init()
    else {
      global.Lampa.Listener.follow('app', function (event) {
        if (event.type === 'ready') init()
      })
    }
  }
})(typeof window !== 'undefined' ? window : globalThis)
