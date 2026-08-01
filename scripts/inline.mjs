// 从 index.template.html 读取（保持外部引用），内联CSS/JS后写入 index.html
// index.template.html 是干净的模板，永远不被修改
// index.html 是内联后的产物，每次构建重新生成

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { EOL } from 'os';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const staticDir = join(__dirname, '..', 'static');
const rootDir = join(__dirname, '..');

// 读取版本号
const pluginJson = JSON.parse(readFileSync(join(rootDir, 'plugin.json'), 'utf8'));
const VERSION = pluginJson.version;
const PLUGIN_NAME = pluginJson.name;
const PLUGIN_NAME_HTML = PLUGIN_NAME.replace(/[&<>"']/g, function(character) {
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
});

const versionSource = ['// 自动生成 — 由 scripts/inline.mjs 从 plugin.json 同步', '', 'export const PLUGIN_VERSION: string = ' + JSON.stringify(VERSION) + ';', ''].join(EOL);
writeFileSync(join(rootDir, 'src', 'version.ts'), versionSource);

// 从模板读取（模板永远保留外部引用，不会被内联代码污染）
let html = readFileSync(join(staticDir, 'index.template.html'), 'utf8');
const css = readFileSync(join(staticDir, 'css', 'style.css'), 'utf8');
const apiJs = readFileSync(join(staticDir, 'js', 'api.js'), 'utf8');
const entitySearchJs = readFileSync(join(staticDir, 'js', 'entity-search.js'), 'utf8');
const playQueueJs = readFileSync(join(staticDir, 'js', 'play-queue.js'), 'utf8');
const appJs = readFileSync(join(staticDir, 'js', 'app.js'), 'utf8');

// 替换插件信息占位符
html = html.replace(/{{VERSION}}/g, VERSION);
html = html.replace(/{{PLUGIN_NAME}}/g, PLUGIN_NAME_HTML);
html = html.replace(/{{PLUGIN_NAME_JSON}}/g, JSON.stringify(PLUGIN_NAME));

// 替换 CSS link 为内联 style
html = html.replace(
  '<link rel="stylesheet" href="css/style.css">',
  '<style>\n' + css + '\n</style>'
);

// 替换 JS script 引用为内联 script
html = html.replace(
  '<script src="js/api.js"></script>',
  '<script>\n' + apiJs + '\n</script>'
);

html = html.replace(
  '<script src="js/entity-search.js"></script>',
  '<script>\n' + entitySearchJs + '\n</script>'
);

html = html.replace(
  '<script src="js/play-queue.js"></script>',
  '<script>\n' + playQueueJs + '\n</script>'
);

html = html.replace(
  '<script src="js/app.js"></script>',
  '<script>\n' + appJs + '\n</script>'
);

// 写入 index.html（构建产物）
writeFileSync(join(staticDir, 'index.html'), html);
console.log('Inline done. Name:', PLUGIN_NAME, '| Version:', VERSION, '| HTML size:', html.length, 'bytes');
console.log('  CSS inlined:', css.length, 'bytes');
console.log('  api.js inlined:', apiJs.length, 'bytes');
console.log('  entity-search.js inlined:', entitySearchJs.length, 'bytes');
console.log('  play-queue.js inlined:', playQueueJs.length, 'bytes');
console.log('  app.js inlined:', appJs.length, 'bytes');
