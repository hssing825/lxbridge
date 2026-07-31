// 计算 plugin.json 的 entryHash 和 zipHash
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const buildDir = path.resolve(__dirname, '..', 'dist', 'build');

// 1. entryHash = sha256(main.js)
const mainJs = fs.readFileSync(path.join(buildDir, 'main.js'));
const entryHash = crypto.createHash('sha256').update(mainJs).digest('hex');
console.log('entryHash:', entryHash);

// 2. zipHash: 所有文件(排除plugin.json)排序后，每文件计算 "path:sha256\n"
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(buildDir, full).replace(/\\/g, '/');
    if (entry.isFile() && rel !== 'plugin.json') {
      const content = fs.readFileSync(full);
      const fileHash = crypto.createHash('sha256').update(content).digest('hex');
      files.push({ path: rel, hash: fileHash });
    } else if (entry.isDirectory()) {
      walk(full);
    }
  }
}
walk(buildDir);
files.sort((a, b) => a.path.localeCompare(b.path));

const zipHasher = crypto.createHash('sha256');
for (const f of files) {
  zipHasher.update(f.path + ':' + f.hash + '\n');
}
const zipHash = zipHasher.digest('hex');
console.log('zipHash:', zipHash);
console.log('Files counted:', files.length);
for (const f of files) {
  console.log('  ' + f.path + ' -> ' + f.hash.substring(0, 16) + '...');
}

// 3. 更新 plugin.json
const pluginPath = path.join(buildDir, 'plugin.json');
const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
plugin.entryHash = entryHash;
plugin.zipHash = zipHash;
fs.writeFileSync(pluginPath, JSON.stringify(plugin, null, 2));
console.log('dist/build/plugin.json updated');

// 4. 同步更新源码 plugin.json
const srcPluginPath = path.resolve(__dirname, '..', 'plugin.json');
const srcPlugin = JSON.parse(fs.readFileSync(srcPluginPath, 'utf8'));
srcPlugin.entryHash = entryHash;
srcPlugin.zipHash = zipHash;
fs.writeFileSync(srcPluginPath, JSON.stringify(srcPlugin, null, 2));
console.log('plugin.json (source) updated');
