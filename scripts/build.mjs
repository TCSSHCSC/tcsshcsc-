import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['web/app.js'], bundle: true, minify: true, format: 'esm', outfile: 'dist/app.js', target: ['es2022'] });
for (const name of ['index.html', 'style.css', 'privacy.html', 'terms.html', 'club-logo.jpg']) await copyFile(`web/${name}`, `dist/${name}`);
for (const name of ['index.html','privacy.html','terms.html']) {
  let html = await readFile('dist/'+name,'utf8');
  for (const asset of ['app.js','style.css']) {
    const version = createHash('sha256').update(await readFile('dist/'+asset)).digest('hex').slice(0,12);
    html = html.replaceAll(`./${asset}"`, `./${asset}?v=${version}"`);
  }
  await writeFile('dist/'+name,html);
}
console.log('Built dist/');

for (const name of ['index.html','app.js','style.css','privacy.html','terms.html','club-logo.jpg']) await copyFile('dist/'+name,name);
await writeFile('.nojekyll','');
