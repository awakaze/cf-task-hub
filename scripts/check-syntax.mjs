// Syntax only, not a substitute for tsc/vue-tsc or a Vite build.
import ts from 'typescript';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
function walk(path){return readdirSync(path,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(path,e.name)):[join(path,e.name)]);}
const files=[...walk('src').filter(f=>/\.(ts|js)$/.test(f)),'web/src/main.ts','web/src/App.vue'];let errors=0;
for(const file of files){let source=readFileSync(file,'utf8');if(file.endsWith('.vue'))source=source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]||'';
 const r=ts.transpileModule(source,{fileName:file.endsWith('.vue')?'App.ts':file,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,isolatedModules:true}});
 for(const d of r.diagnostics||[])if(d.category===ts.DiagnosticCategory.Error){console.error(file,ts.flattenDiagnosticMessageText(d.messageText,'\n'));errors++;}}
console.log(`${files.length} script files checked for parser/transpiler diagnostics; ${errors} errors. Vue template compilation is a separate build gate.`);process.exitCode=errors?1:0;
