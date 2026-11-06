#!/usr/bin/env node
// 打一个 GitHub Release：建 tag → 上传 npm pack 产物 → 打印链接。
//
// 每次版本号变化都要跑一次。以前是手工在网页上点出来的，于是 0.4.3 到 0.6.4 之间
// 十个小版本全没有产物 —— 服务器上是本地 tgz，GitHub 上没有对应资产。
//
// 用 `node:https` 而不是 `fetch`：Node 25 的 undici 在 Windows 上退出时会触发
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，一次上传会在成功后崩掉。
//
// 用法：
//   node scripts/release.mjs                       # 用 package.json 的版本，说明自动生成
//   node scripts/release.mjs --notes notes.md --name "v1.2.3 - 摘要"
//   node scripts/release.mjs --dry-run
// 已存在同名 release 时只补传资产，不会重复创建。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:https'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const REPO = 'ruqinhu/dsh-weixin-link'
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const arg = (flag) => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const tag = `v${version}`
const tarball = `ruqinhu-dsh-weixin-link-${version}.tgz`

function token() {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  // `git config credential.helper=store` 把 PAT 存在这里，push 能用就说明它有效。
  try {
    const line = readFileSync(join(homedir(), '.git-credentials'), 'utf8')
      .split('\n')
      .find((entry) => entry.includes('github.com'))
    return line.split('://')[1].split('@')[0].split(':').pop()
  } catch {
    throw new Error('no GH_TOKEN and no ~/.git-credentials entry for github.com')
  }
}

/** One HTTPS request; resolves with the parsed JSON body (or the raw text). */
function call(url, { method = 'GET', body, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-weixin-link-release',
    }
    if (body !== undefined) {
      headers['Content-Type'] = contentType ?? 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(body))
    }
    const req = request(url, { method, headers }, (response) => {
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => (raw += chunk))
      response.on('end', () => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          reject(new Error(`${method} ${url} -> ${status} ${raw.slice(0, 300)}`))
          return
        }
        resolve(raw === '' ? {} : JSON.parse(raw))
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** 上一个 tag 到 HEAD 的提交标题，作为默认 release notes。 */
function defaultNotes() {
  try {
    const previous = execFileSync('git', ['describe', '--tags', '--abbrev=0', `${tag}^`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return `Changes since ${previous}:\n\n${execFileSync('git', ['log', `${previous}..HEAD`, '--pretty=- %s'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim()}\n`
  } catch {
    return execFileSync('git', ['log', '-20', '--pretty=- %s'], { cwd: ROOT, encoding: 'utf8' }).trim()
  }
}

const body = arg('--notes') === undefined ? defaultNotes() : readFileSync(arg('--notes'), 'utf8')
const name = arg('--name') ?? `${tag} - ${(pkg.description ?? '').split(':')[0]}`

if (dryRun) {
  console.log(`would create ${tag} (${name})\nasset: ${tarball}\n\n${body}`)
  process.exit(0)
}

if (!existsSync(join(ROOT, tarball))) {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
  execFileSync('npm', ['pack', '--silent'], { cwd: ROOT, stdio: 'inherit' })
}

let release
try {
  release = await call(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`)
} catch {
  release = await call(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, target_commitish: 'main', name, body, draft: false }),
  })
}

const existing = (release.assets ?? []).map((asset) => asset.name)
if (!existing.includes(tarball)) {
  const asset = await call(`https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${tarball}`, {
    method: 'POST',
    body: readFileSync(join(ROOT, tarball)),
    contentType: 'application/octet-stream',
  })
  console.log(`uploaded ${asset.name} (${asset.size} bytes)`)
} else {
  console.log(`asset already present: ${tarball}`)
}

try {
  execFileSync('git', ['tag', '-f', tag], { cwd: ROOT, stdio: 'ignore' })
  execFileSync('git', ['push', 'origin', tag, '--force'], { cwd: ROOT, stdio: 'ignore' })
} catch {
  // The API already created the tag server-side; a local tag is a convenience.
}

console.log(release.html_url)
process.exit(0)
