export interface ListPreset {
  id: string
  title: string
  description: string
  username: string
  slug: string
}

export interface PresetsResponse {
  version: 1
  updatedAt: string
  source: string
  lists: ListPreset[]
}

export interface PresetCatalogBinding {
  get(key: string, type: 'json'): Promise<unknown>
}

export const PRESET_CATALOG_KEY = 'list-presets:v1'

// A deliberately small, verified fallback catalog. The Worker endpoint lets
// the plugin receive catalog updates without publishing a new plugin bundle.
export const LIST_PRESETS: ListPreset[] = [
  {
    id: 'official-top-500',
    title: "Letterboxd's Top 500 Films",
    description: 'Официальный рейтинг полнометражных фильмов по оценкам пользователей.',
    username: 'official',
    slug: 'letterboxds-top-500-films',
  },
  {
    id: 'watch-once',
    title: 'Movies Everyone Should Watch at Least Once',
    description: 'Одна из самых популярных пользовательских подборок Letterboxd.',
    username: 'fcbarcelona',
    slug: 'movies-everyone-should-watch-at-least-once',
  },
  {
    id: 'feel-something',
    title: 'For When You Want to Feel Something',
    description: 'Популярная подборка эмоционального кино.',
    username: 'ellefnning',
    slug: 'for-when-you-want-to-feel-something',
  },
  {
    id: 'classic-beginners',
    title: 'Classic Movies for Beginners',
    description: 'Доступная точка входа в классическое кино.',
    username: 'hepburnluv',
    slug: 'classic-movies-for-beginners',
  },
  {
    id: '1001-movies',
    title: '1001 Movies You Must See Before You Die',
    description: 'Полная подборка фильмов из одноимённой книжной серии.',
    username: 'peterstanley',
    slug: '1001-movies-you-must-see-before-you-die',
  },
  {
    id: 'most-fans-250',
    title: 'Top 250 Films with the Most Fans',
    description: 'Официальный рейтинг фильмов с наибольшим числом поклонников.',
    username: 'official',
    slug: 'top-250-films-with-the-most-fans',
  },
  {
    id: 'animated-250',
    title: 'Top 250 Animated Films',
    description: 'Официальный рейтинг полнометражной анимации.',
    username: 'official',
    slug: 'top-250-animated-films',
  },
]

export function presetsResponse(): PresetsResponse {
  return {
    version: 1,
    updatedAt: '2026-09-06T00:00:00.000Z',
    source: 'https://letterboxd.com/lists/popular/',
    lists: LIST_PRESETS,
  }
}

function isListPreset(value: unknown): value is ListPreset {
  if (!value || typeof value !== 'object') return false
  const preset = value as Partial<ListPreset>

  return (
    typeof preset.id === 'string' &&
    preset.id.length > 0 &&
    typeof preset.title === 'string' &&
    preset.title.length > 0 &&
    typeof preset.description === 'string' &&
    typeof preset.username === 'string' &&
    /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(preset.username) &&
    typeof preset.slug === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,119}$/i.test(preset.slug)
  )
}

function isPresetsResponse(value: unknown): value is PresetsResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<PresetsResponse>

  return (
    response.version === 1 &&
    typeof response.updatedAt === 'string' &&
    !Number.isNaN(Date.parse(response.updatedAt)) &&
    typeof response.source === 'string' &&
    response.source.startsWith('https://') &&
    Array.isArray(response.lists) &&
    response.lists.length > 0 &&
    response.lists.length <= 50 &&
    response.lists.every(isListPreset)
  )
}

export async function readPresetsResponse(
  binding?: PresetCatalogBinding,
): Promise<PresetsResponse> {
  if (!binding) return presetsResponse()

  try {
    const stored = await binding.get(PRESET_CATALOG_KEY, 'json')
    if (isPresetsResponse(stored)) return stored
  } catch (error) {
    console.error('Preset catalog KV read failed; using the built-in catalog', error)
  }

  return presetsResponse()
}
