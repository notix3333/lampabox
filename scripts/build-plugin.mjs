import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const sourcePath = resolve(projectRoot, 'plugin/letterboxd-watchlist.js')
const outputPath = resolve(projectRoot, 'dist/letterboxd-watchlist.js')
const defaultApiUrl = 'https://example.workers.dev'
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

const source = await readFile(sourcePath, 'utf8')
const marker = "const API_BASE_URL = 'https://example.workers.dev'"

if (!source.includes(marker)) {
  throw new Error('Could not find API_BASE_URL build marker in plugin source')
}

const built = source.replace(marker, `const API_BASE_URL = ${JSON.stringify(apiBaseUrl)}`)

await mkdir(resolve(projectRoot, 'dist'), { recursive: true })
await writeFile(outputPath, built, 'utf8')

console.log(`Built ${outputPath}`)
console.log(`Worker API: ${apiBaseUrl}`)
