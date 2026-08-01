import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const template = fs.readFileSync(new URL('../static/index.template.html', import.meta.url), 'utf8')
const app = fs.readFileSync(new URL('../static/js/app.js', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../static/css/style.css', import.meta.url), 'utf8')

test('diagnostics has dedicated desktop and mobile navigation entries', () => {
  assert.match(template, /class="nav-item" data-page="diagnostics"/)
  assert.match(template, /class="mobile-more-item" data-page="diagnostics"/)

  const settingsPage = template.slice(
    template.indexOf('id="page-settings"'),
    template.indexOf('id="page-diagnostics"'),
  )
  assert.doesNotMatch(settingsPage, /打开系统诊断|<h3>[^<]*系统诊断/)
})

test('diagnostics renders four compact summary cards and two closed disclosures', () => {
  assert.match(app, /data-diag-card=/)
  for (const card of ['core', 'protection', 'sources', 'local']) {
    assert.match(app, new RegExp("card\\('" + card + "'"))
  }
  assert.match(app, /class="diag-summary-grid"/)
  assert.match(app, /<details class="diag-disclosure"/)
  assert.match(app, /异常与最近活动/)
  assert.match(app, /高级事件/)
  assert.doesNotMatch(app, /<details class="diag-disclosure" open/)
})

test('diagnostics layout is two columns on desktop and one column on mobile', () => {
  assert.match(css, /\.diag-summary-grid\s*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/s)
  assert.match(css, /@media\s*\(max-width:768px\)[\s\S]*?\.diag-summary-grid\s*\{[^}]*grid-template-columns:1fr/s)
  assert.match(css, /\.diag-card\s*\{[^}]*min-width:0/s)
})
