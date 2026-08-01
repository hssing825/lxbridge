// 完整复制 songloft-plugin-builder 的构建流程
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync, statSync } from 'fs';
import { join, relative, posix } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const cwd = join(__dirname, '..');
const outDir = join(cwd, 'dist');
const buildDir = join(outDir, 'build'); // 用 build 而非 _build，保持一致

// 清理
import { rmSync } from 'fs';
try { rmSync(outDir, { recursive: true, force: true }); } catch (e) { console.log('Clean warning:', e.message); }
try { mkdirSync(buildDir, { recursive: true }); } catch (e) { console.log('Mkdir error:', e.message); }

// 步骤0: 内联 CSS/JS → index.html → embed 到 TypeScript
console.log('0. Inlining CSS/JS into index.html...');
await import('./inline.mjs');
console.log('0b. Embedding HTML into src/html_content.ts...');
await import('./embed-html.mjs');

console.log('1. Compiling src/main.ts → build/main.js (esbuild IIFE)...');

// 步骤1: 编译 TypeScript（复制 builder 的 esbuild 配置）
const entryPoint = join(cwd, 'src', 'main.ts');
if (!existsSync(entryPoint)) {
  console.error('Entry not found:', entryPoint);
  process.exit(1);
}

await esbuild.build({
  entryPoints: [entryPoint],
  outfile: join(buildDir, 'main.js'),
  bundle: true,
  platform: 'neutral',
  format: 'iife',
  target: 'es2020',
  minify: false,
  sourcemap: false,
  plugins: [{
    name: 'no-node-builtins',
    setup(build) {
      build.onResolve({ filter: /^(fs|net|http|https|child_process|os|path|crypto|stream|util|events|buffer|url|querystring|zlib)$/ }, (args) => {
        return { errors: [{ text: `Node builtin "${args.path}" is not available in QuickJS runtime` }] };
      });
    }
  }]
});

console.log('   ✓ main.js compiled');

// 步骤2: 只复制 index.html 和 icon.svg（CSS/JS已内联到HTML，无需单独复制）
try {
  const staticDir = join(cwd, 'static');
  const buildStatic = join(buildDir, 'static');
  mkdirSync(buildStatic, { recursive: true });

  // 只复制必要文件（index.html 已内联 CSS/JS，无需 css/ js/ 子目录）
  const htmlPath = join(staticDir, 'index.html');
  if (existsSync(htmlPath)) {
    writeFileSync(join(buildStatic, 'index.html'), readFileSync(htmlPath));
    console.log('   ✓ static/index.html copied (CSS/JS inlined)');
  }
  const iconPath = join(staticDir, 'icon.svg');
  if (existsSync(iconPath)) {
    writeFileSync(join(buildStatic, 'icon.svg'), readFileSync(iconPath));
    console.log('   ✓ static/icon.svg copied');
  }
} catch (e) {
  console.error('   ✗ static copy failed:', e.message, e.stack);
}

// 步骤3: 读取 plugin.json
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(cwd, 'plugin.json'), 'utf8'));
  console.log('2. Plugin:', manifest.name, 'v' + manifest.version);
} catch (e) {
  console.error('   ✗ plugin.json read failed:', e.message);
  process.exit(1);
}

// 步骤4: 计算 hash
function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

// entryHash
const mainJsContent = readFileSync(join(buildDir, 'main.js'));
const entryHash = sha256Hex(mainJsContent);
console.log('   entryHash:', entryHash);

// zipHash（使用builder的精确算法）
function computeCanonicalZipHash(dir) {
  const entries = [];
  function walk(d) {
    const items = readdirSync(d);
    for (const item of items) {
      const fullPath = join(d, item);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else {
        const relPath = posix.normalize(relative(dir, fullPath).replace(/\\/g, '/'));
        if (relPath === 'plugin.json') continue;
        const content = readFileSync(fullPath);
        entries.push({ path: relPath, hash: sha256Hex(content) });
      }
    }
  }
  walk(dir);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const hasher = createHash('sha256');
  for (const e of entries) {
    hasher.update(e.path + '\n' + e.hash + '\n');
  }
  return hasher.digest('hex');
}

const zipHash = computeCanonicalZipHash(buildDir);
console.log('   zipHash:', zipHash);

// 列出所有文件
console.log('\n   Files in build:');
function listFiles(dir, prefix) {
  const items = readdirSync(dir).sort();
  for (const item of items) {
    const full = join(dir, item);
    if (statSync(full).isDirectory()) {
      listFiles(full, prefix + item + '/');
    } else {
      const rel = prefix + item;
      const sz = statSync(full).size;
      console.log('     ' + rel + ' (' + sz + ' bytes)');
    }
  }
}
listFiles(buildDir, '');

// 步骤5: 更新 plugin.json
const finalManifest = { ...manifest, main: 'main.js', entryHash, zipHash };
const pluginPath = join(buildDir, 'plugin.json');
writeFileSync(pluginPath, JSON.stringify(finalManifest, null, 2));
console.log('\n3. plugin.json updated with hashes');

// 步骤5.5: 验证 JS 语法（避免 syntax error 上线）
// 内联 JS 很大，不能通过命令行参数传给 node -e（Windows 命令行长度有限），
// 改为写入临时文件后用 node --check 校验。
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
const htmlPath = join(buildDir, 'static', 'index.html');
const htmlContent = readFileSync(htmlPath, 'utf8');
const scripts = htmlContent.match(/<script>([\s\S]*?)<\/script>/g)?.map(s => s.replace(/<script>|<\/script>/g, '')).join('\n');
let syntaxTmpDir = '';
try {
  syntaxTmpDir = mkdtempSync(join(tmpdir(), 'lxbridge-syntax-'));
  const checkPath = join(syntaxTmpDir, 'check.js');
  writeFileSync(checkPath, scripts ?? '');
  execFileSync(process.execPath, ['--check', checkPath], { timeout: 5000, stdio: 'pipe' });
  console.log('   ✓ JS syntax validated');
} catch (e) {
  console.error('JS Syntax Check FAILED:', e.stderr?.toString()?.substring(0, 200) || e.message);
  throw e;
} finally {
  if (syntaxTmpDir) rmSync(syntaxTmpDir, { recursive: true, force: true });
}

// 步骤6: 创建 zip
console.log('4. Creating zip...');

import JSZip from 'jszip';
const zip = new JSZip();

function addDirToZip(z, dir, zipPrefix) {
  const items = readdirSync(dir);
  for (const item of items) {
    const fullPath = join(dir, item);
    if (statSync(fullPath).isDirectory()) {
      addDirToZip(z, fullPath, zipPrefix + item + '/');
    } else {
      z.file(zipPrefix + item, readFileSync(fullPath));
    }
  }
}
addDirToZip(zip, buildDir, '');

const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
const zipPath = join(outDir, 'lxbridge.jsplugin.zip');
writeFileSync(zipPath, zipBuf);
console.log('   ✓ ' + zipPath + ' (' + zipBuf.length + ' bytes)');

// 步骤7: 验证
console.log('\n5. Verification:');
const finalPlugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
console.log('   entryHash:', finalPlugin.entryHash);
console.log('   zipHash:', finalPlugin.zipHash);
console.log('   main:', finalPlugin.main);
console.log('\n✅ Build complete!');
