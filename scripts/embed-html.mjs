// 将 index.html 内联为 JS 字符串，嵌入到 HTML_ROUTE.ts 中
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const html = readFileSync(join(__dirname, '..', 'static', 'index.html'), 'utf8');

// 生成一个 TypeScript 文件，导出 HTML 字符串
const ts = `// 自动生成 — 由 scripts/embed-html.mjs 构建
// 内联的 index.html（包含CSS+JS），插件运行时直接serve，不走静态文件系统

export const INDEX_HTML: string = ${JSON.stringify(html)};
`;

writeFileSync(join(__dirname, '..', 'src', 'html_content.ts'), ts);
console.log('Embedded HTML into src/html_content.ts');
console.log('HTML size:', html.length, 'bytes');
