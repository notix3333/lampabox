(function (global) {
  'use strict'

  const PLUGIN_NAME = 'Letterboxd Watchlist'
  const PLUGIN_VERSION = '1.1.0'
  const STORAGE_USERNAME = 'letterboxd_watchlist_username'
  const STORAGE_LISTS = 'letterboxd_public_lists'
  const STORAGE_API_URL = 'letterboxd_watchlist_api_url'
  const API_BASE_URL = 'https://lampa-letterboxd-watchlist.rexikplay3.workers.dev'
  const MAX_TMDB_CONCURRENCY = 5
  const REQUEST_RETRY_DELAYS = [250, 500]
  const TMDB_RETRY_DELAYS = [200, 400]
  const TMDB_TIMEOUT_MS = 15000

  const sourceStates = Object.create(null)
  let errorShown = false

  function log() {
    const args = Array.prototype.slice.call(arguments)
    args.unshift(`[${PLUGIN_NAME}]`)
    console.log.apply(console, args)
  }

  function normalizeTitle(title) {
    return String(title || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
  }

  function releaseYear(item) {
    const value = item && (item.release_date || item.first_air_date)
    const match = typeof value === 'string' ? value.match(/^(\d{4})/) : null
    return match ? Number(match[1]) : null
  }

  function localizedTitle(item) {
    return item && (item.title || item.name)
  }

  function originalTitle(item) {
    return item && (item.original_title || item.original_name)
  }

  function pickBestTmdbResult(film, movieResults, tvResults) {
    if (!film || !film.year) return null

    const movies = Array.isArray(movieResults) ? movieResults : []
    const shows = Array.isArray(tvResults) ? tvResults : []
    const wantedTitle = normalizeTitle(film.title)
    const candidates = movies
      .map(function (item) {
        return { item: item, mediaType: 'movie' }
      })
      .concat(
        shows.map(function (item) {
          return { item: item, mediaType: 'tv' }
        }),
      )
      .filter(function (candidate) {
        return candidate.item && candidate.item.id && releaseYear(candidate.item) !== null
      })

    const rules = [
      function (candidate) {
        return (
          normalizeTitle(localizedTitle(candidate.item)) === wantedTitle &&
          releaseYear(candidate.item) === film.year
        )
      },
      function (candidate) {
        return (
          normalizeTitle(originalTitle(candidate.item)) === wantedTitle &&
          releaseYear(candidate.item) === film.year
        )
      },
      function (candidate) {
        return (
          normalizeTitle(localizedTitle(candidate.item)) === wantedTitle &&
          Math.abs(releaseYear(candidate.item) - film.year) <= 1
        )
      },
      function (candidate) {
        return (
          normalizeTitle(originalTitle(candidate.item)) === wantedTitle &&
          Math.abs(releaseYear(candidate.item) - film.year) <= 1
        )
      },
    ]

    for (let index = 0; index < rules.length; index += 1) {
      const match = candidates.find(rules[index])
      if (match) {
        return Object.assign({}, match.item, {
          media_type: match.mediaType,
          source: 'tmdb',
        })
      }
    }

    return null
  }

  function mapWithConcurrency(items, limit, mapper, onSettled) {
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
        .then(function () {
          if (onSettled) onSettled(results[index], index)
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

  function createTaskLimiter(limit) {
    let active = 0
    const waiting = []

    function startNext() {
      if (active >= limit || !waiting.length) return

      const entry = waiting.shift()
      active += 1
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .then(
          function () {
            active -= 1
            startNext()
          },
          function () {
            active -= 1
            startNext()
          },
        )
    }

    return function (task) {
      return new Promise(function (resolve, reject) {
        waiting.push({ task: task, resolve: resolve, reject: reject })
        startNext()
      })
    }
  }

  function retryWithBackoff(operation, delays, sleeper, shouldRetry) {
    let attempt = 0
    const wait = sleeper || function (delay) {
      return new Promise(function (resolve) {
        setTimeout(resolve, delay)
      })
    }

    function run() {
      return Promise.resolve()
        .then(function () {
          return operation(attempt)
        })
        .catch(function (error) {
          if (attempt >= delays.length || (shouldRetry && !shouldRetry(error))) throw error
          const delay = delays[attempt]
          attempt += 1
          return wait(delay).then(run)
        })
    }

    return run()
  }

  function parseListEntries(value, defaultUsername) {
    const usernamePattern = /^[a-z0-9][a-z0-9_-]{0,39}$/i
    const slugPattern = /^[a-z0-9][a-z0-9-]{0,119}$/i
    const seen = Object.create(null)
    const result = []

    String(value || '')
      .split(/[\n,;]+/)
      .map(function (entry) {
        return entry.trim()
      })
      .filter(Boolean)
      .forEach(function (entry) {
        let username = ''
        let slug = ''
        const urlMatch = entry.match(
          /^https?:\/\/(?:www\.)?letterboxd\.com\/([^/]+)\/list\/([^/?#]+)\/?(?:[?#].*)?$/i,
        )

        if (urlMatch) {
          username = urlMatch[1]
          slug = urlMatch[2]
        } else {
          const path = entry.replace(/^\/+|\/+$/g, '')
          const longPath = path.match(/^([^/]+)\/list\/([^/]+)$/i)
          const shortPath = path.match(/^([^/]+)\/([^/]+)$/)

          if (longPath) {
            username = longPath[1]
            slug = longPath[2]
          } else if (shortPath) {
            username = shortPath[1]
            slug = shortPath[2]
          } else {
            username = defaultUsername
            slug = path
          }
        }

        if (!usernamePattern.test(username) || !slugPattern.test(slug)) return

        const key = `${username.toLowerCase()}/${slug.toLowerCase()}`
        if (seen[key]) return
        seen[key] = true
        result.push({ username: username, slug: slug, key: key })
      })

    return result
  }

  const runTmdbTask = createTaskLimiter(MAX_TMDB_CONCURRENCY)

  function searchTmdbOnce(film) {
    return new Promise(function (resolve, reject) {
      let settled = false
      const timeout = setTimeout(function () {
        if (settled) return
        settled = true
        reject(new Error('TMDB search timed out'))
      }, TMDB_TIMEOUT_MS)

      try {
        global.Lampa.Api.search({ query: film.title }, function (result) {
          if (settled) return
          settled = true
          clearTimeout(timeout)

          const hasMovieSection = Boolean(result && result.movie)
          const hasTvSection = Boolean(result && result.tv)
          if (!hasMovieSection && !hasTvSection) {
            reject(new Error('TMDB search returned no sections'))
            return
          }

          const movies = hasMovieSection && Array.isArray(result.movie.results)
            ? result.movie.results
            : []
          const shows = hasTvSection && Array.isArray(result.tv.results) ? result.tv.results : []
          resolve(pickBestTmdbResult(film, movies, shows))
        })
      } catch (error) {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      }
    })
  }

  function searchTmdb(film) {
    return retryWithBackoff(function () {
      return searchTmdbOnce(film)
    }, TMDB_RETRY_DELAYS)
  }

  function workerError(error) {
    const payload = error && error.responseJSON && error.responseJSON.error
    return payload && payload.code ? payload : null
  }

  function shouldRetryWorkerRequest(error) {
    const details = workerError(error)
    if (!details) return true

    return details.code === 'LETTERBOXD_BLOCKED' || details.code === 'LETTERBOXD_ERROR'
  }

  function configuredApiBaseUrl() {
    return String(global.Lampa.Storage.get(STORAGE_API_URL, API_BASE_URL) || '')
      .trim()
      .replace(/\/+$/, '')
  }

  function requestCollection(config, apiBaseUrl) {
    return retryWithBackoff(
      function () {
        return new Promise(function (resolve, reject) {
          const network = new global.Lampa.Reguest()
          const path =
            config.kind === 'watchlist'
              ? `/watchlist/${encodeURIComponent(config.username)}`
              : `/list/${encodeURIComponent(config.username)}/${encodeURIComponent(config.slug)}`

          network.timeout(30000)
          network.native(apiBaseUrl + path, resolve, reject)
        })
      },
      REQUEST_RETRY_DELAYS,
      null,
      shouldRetryWorkerRequest,
    )
  }

  function notificationFor(error) {
    const details = workerError(error)

    if (details && details.code === 'USER_NOT_FOUND') return 'Letterboxd: пользователь не найден'
    if (details && details.code === 'INVALID_USERNAME') return 'Letterboxd: некорректный username'
    if (details && details.code === 'INVALID_LIST') return 'Letterboxd: некорректный адрес списка'
    if (details && details.code === 'LETTERBOXD_BLOCKED') return 'Letterboxd временно блокирует запросы'
    if (details && details.code === 'LIST_UNAVAILABLE') {
      return 'Letterboxd list не найден или закрыт'
    }
    if (details && details.code === 'WATCHLIST_UNAVAILABLE') {
      return 'Не удалось получить Letterboxd Watchlist. Проверьте username и доступность watchlist.'
    }

    return 'Letterboxd временно недоступен'
  }

  function notifyOnce(message) {
    if (errorShown) return
    errorShown = true
    global.Lampa.Noty.show(message)
  }

  function createSourceState(config) {
    let resolveReady
    const state = {
      config: config,
      title: config.title,
      results: [],
      matches: [],
      settled: [],
      nextFlushIndex: 0,
      total: 0,
      completed: false,
      started: false,
      readyResolved: false,
      line: null,
      ready: new Promise(function (resolve) {
        resolveReady = resolve
      }),
      resolveReady: function () {
        if (state.readyResolved) return
        state.readyResolved = true
        resolveReady(state.results)
      },
    }

    sourceStates[config.key] = state
    return state
  }

  function appendPendingCards(state) {
    const line = state.line
    if (!line || typeof line.emit !== 'function') return

    const items = Array.isArray(line.items) ? line.items : []
    for (let index = items.length; index < state.results.length; index += 1) {
      line.emit('createAndAppend', state.results[index])
    }
  }

  function flushSettled(state) {
    while (state.settled[state.nextFlushIndex]) {
      const match = state.matches[state.nextFlushIndex]
      state.nextFlushIndex += 1

      if (match) {
        state.results.push(match)
        appendPendingCards(state)
      }
    }

    if (state.results.length) state.resolveReady()

    if (state.nextFlushIndex >= state.total) {
      state.completed = true
      state.resolveReady()
      log(`${state.title}: TMDB matched ${state.results.length}/${state.total}`)
    }
  }

  function loadSource(state, apiBaseUrl) {
    if (state.started) return state.ready
    state.started = true

    requestCollection(state.config, apiBaseUrl)
      .then(function (payload) {
        if (!payload || payload.version !== 1 || !Array.isArray(payload.films)) {
          throw new Error('Worker returned an invalid response')
        }

        state.title = String(payload.title || state.title)
        state.total = payload.films.length
        log(`${state.title}: received ${state.total}`)

        if (!state.total) {
          state.completed = true
          state.resolveReady()
          return
        }

        return mapWithConcurrency(
          payload.films,
          MAX_TMDB_CONCURRENCY,
          function (film) {
            return runTmdbTask(function () {
              return searchTmdb(film)
            })
          },
          function (match, index) {
            state.matches[index] = match
            state.settled[index] = true
            flushSettled(state)
          },
        )
      })
      .catch(function (error) {
        state.completed = true
        state.resolveReady()
        log(`${state.title}: error`, error)
        notifyOnce(notificationFor(error))
      })

    return state.ready
  }

  function configuredSources() {
    const username = String(global.Lampa.Storage.get(STORAGE_USERNAME, '') || '').trim()
    const listValue = global.Lampa.Storage.get(STORAGE_LISTS, '')
    const sources = []

    if (username) {
      sources.push({
        kind: 'watchlist',
        username: username,
        key: `watchlist:${username.toLowerCase()}`,
        title: PLUGIN_NAME,
      })
    }

    parseListEntries(listValue, username).forEach(function (list) {
      sources.push({
        kind: 'list',
        username: list.username,
        slug: list.slug,
        key: `list:${list.key}`,
        title: `Letterboxd: ${list.slug.replace(/-/g, ' ')}`,
      })
    })

    return sources
  }

  function registerSettings() {
    global.Lampa.SettingsApi.addComponent({
      component: 'letterboxd',
      name: 'Letterboxd',
      icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="32" r="12" fill="#00e054"/><circle cx="32" cy="32" r="12" fill="#40bcf4"/><circle cx="48" cy="32" r="12" fill="#ff8000"/></svg>',
    })

    global.Lampa.SettingsApi.addParam({
      component: 'letterboxd',
      param: { name: STORAGE_USERNAME, type: 'input', default: '', placeholder: 'username' },
      field: {
        name: 'Letterboxd username',
        description: 'Публичный username для Watchlist и коротких адресов lists.',
      },
    })

    global.Lampa.SettingsApi.addParam({
      component: 'letterboxd',
      param: {
        name: STORAGE_LISTS,
        type: 'input',
        default: '',
        placeholder: 'owner/list-slug, another-list',
      },
      field: {
        name: 'Public lists',
        description: 'Через запятую: owner/list-slug, полный Letterboxd URL или slug текущего username.',
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
        description: 'Адрес единственного Cloudflare Worker. Изменения применятся после перезапуска.',
      },
    })
  }

  function registerLineListener() {
    global.Lampa.Listener.follow('line', function (event) {
      const key = event && event.data && event.data.letterboxd_source
      const state = key && sourceStates[key]
      if (!state) return

      if (event.type === 'create') {
        state.line = event.line
        if (!state.completed) appendPendingCards(state)
      } else if (event.type === 'destroy' && state.line === event.line) {
        state.line = null
      }
    })
  }

  function registerContentRows(sources, apiBaseUrl) {
    sources.forEach(function (config, index) {
      const state = createSourceState(config)

      global.Lampa.ContentRows.add({
        name: `letterboxd_collection_${index}`,
        title: config.title,
        screen: ['main'],
        call: function () {
          return function (call) {
            loadSource(state, apiBaseUrl).then(function () {
              call({
                title: state.title,
                results: state.results,
                total_pages: 1,
                nomore: true,
                letterboxd_source: config.key,
              })
            })
          }
        },
      })

      loadSource(state, apiBaseUrl)
    })
  }

  function init() {
    if (global.plugin_letterboxd_watchlist_ready) return
    global.plugin_letterboxd_watchlist_ready = true

    registerSettings()
    const sources = configuredSources()
    if (!sources.length) {
      log('plugin initialized without configured collections', PLUGIN_VERSION)
      return
    }

    const apiBaseUrl = configuredApiBaseUrl()
    if (!/^https?:\/\/[^\s]+$/i.test(apiBaseUrl)) {
      notifyOnce('Letterboxd: указан некорректный адрес Worker')
      return
    }
    registerLineListener()
    registerContentRows(sources, apiBaseUrl)
    log('plugin initialized', PLUGIN_VERSION)
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createTaskLimiter,
      mapWithConcurrency,
      normalizeTitle,
      parseListEntries,
      pickBestTmdbResult,
      retryWithBackoff,
    }
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
