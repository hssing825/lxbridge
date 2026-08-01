import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const template = fs.readFileSync(new URL('../static/index.template.html', import.meta.url), 'utf8')

test('about changelog groups entries by major and minor version', () => {
  const versions = Array.from(template.matchAll(/class="cl-ver">(v[^<]+)</g), match => match[1])

  assert.ok(versions.length > 0)
  for (const version of versions) {
    assert.match(version, /^v\d+\.\d+$/)
  }
})
