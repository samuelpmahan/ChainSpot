/** Small, deliberately bounded packer for this prototype's four browser modules.
 * Produces a self-contained demo; there are no network assets or npm dependencies.
 * The modules remain the source of truth. This is not a general-purpose bundler.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'static/creator-v0');
const out = path.resolve(process.argv[2] || path.join(root, 'experiments/creator-v0/dist/chainspot-creator-v0.html'));
const modules = ['model.js', 'storage.js', 'render.js', 'app.js'];
let script = '(()=>{\nconst __modules = {};\n';
for (const name of modules) {
  let code = fs.readFileSync(path.join(source, name), 'utf8');
  const exports = [...code.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)].map(m=>m[1]);
  code = code.replace(/^import\s*\{([\s\S]*?)\}\s*from\s*['"](.+?)['"];?/gm, (_, symbols, id) => {
    if (!id.startsWith('./') || !modules.includes(id.slice(2))) throw Error(`Unexpected import ${id}`);
    return `const {${symbols}} = __modules[${JSON.stringify(id)}];`;
  }).replace(/^export\s+/gm, '');
  if (/^\s*import\s/m.test(code)) throw Error(`Unsupported import in ${name}`);
  script += `__modules[${JSON.stringify('./'+name)}] = (()=>{\n${code}\nreturn {${exports.join(',')}};\n})();\n`;
}
script += '})();';
let html = fs.readFileSync(path.join(source,'index.html'),'utf8');
html = html.replace('<link rel="stylesheet" href="./styles.css"/>',`<style>\n${fs.readFileSync(path.join(source,'styles.css'),'utf8')}\n</style>`);
html = html.replace('<script type="module" src="./app.js"></script>',`<script>\n${script.replace(/<\/script/gi,'<\\/script')}\n</script>`);
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,html);
console.log(`${out} (${Buffer.byteLength(html)} bytes)`);
