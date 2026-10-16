import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['web/app.js'], bundle: true, minify: true, format: 'esm', outfile: 'dist/app.js', target: ['es2022'] });
for (const name of ['index.html', 'style.css', 'privacy.html', 'terms.html']) await copyFile(`web/${name}`, `dist/${name}`);
console.log('Built dist/');

await mkdir('docs', {recursive:true});
for (const name of ['index.html','app.js','style.css','privacy.html','terms.html']) await copyFile('dist/'+name,'docs/'+name);
await writeFile('docs/.nojekyll','');
