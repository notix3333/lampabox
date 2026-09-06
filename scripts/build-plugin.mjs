import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const sourcePath = resolve(projectRoot, 'plugin/letterboxd-watchlist.js')
const outputPath = resolve(projectRoot, 'dist/letterboxd-watchlist.js')
const headersSourcePath = resolve(projectRoot, 'worker/static/_headers')
const headersOutputPath = resolve(projectRoot, 'dist/_headers')
const defaultApiUrl = 'https://lampa-letterboxd-watchlist.lampabox.workers.dev'
const apiBaseUrl = (process.env.API_BASE_URL || defaultApiUrl).replace(/\/+$/, '')

let parsedUrl

try {
  parsedUrl = new URL(apiBaseUrl)
} catch {
  throw new Error('API_BASE_URL must be a valid absolute URL')
}

if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost') {
  throw new Error('API_BASE_URL must use HTTPS (HTTP is allowed only for localhost)')
}

const [source, headers] = await Promise.all([
  readFile(sourcePath, 'utf8'),
  readFile(headersSourcePath, 'utf8'),
])
const marker = /const API_BASE_URL = '[^']+'/

if (!marker.test(source)) {
  throw new Error('Could not find API_BASE_URL build marker in plugin source')
}

const built = source.replace(marker, `const API_BASE_URL = ${JSON.stringify(apiBaseUrl)}`)

await mkdir(resolve(projectRoot, 'dist'), { recursive: true })
await Promise.all([
  writeFile(outputPath, built, 'utf8'),
  writeFile(headersOutputPath, headers, 'utf8'),
])

console.log(`Built ${outputPath}`)
console.log(`Worker API: ${apiBaseUrl}`)
