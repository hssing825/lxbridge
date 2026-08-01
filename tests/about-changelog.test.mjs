import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const template = fs.readFileSync(new URL('../static/index.template.html', import.meta.url), 'utf8')
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'))

test('about changelog uses three-part versions only for major and minor releases', () => {
  const versions = Array.from(template.matchAll(/class="cl-ver">(v[^<]+)</g), match => match[1])
  const [major, minor] = manifest.version.split('.')
  const currentReleaseLine = `v${major}.${minor}.0`

  assert.ok(versions.length > 0)
  for (const version of versions) {
    assert.match(version, /^v\d+\.\d+\.0$/)
  }
  assert.equal(versions[0], currentReleaseLine)
  assert.equal(new Set(versions.map(version => version.split('.').slice(0, 2).join('.'))).size, versions.length)
})
