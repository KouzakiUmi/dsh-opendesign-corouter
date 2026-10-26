import { build } from 'esbuild';
import { mkdir, lstat, realpath, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
if (process.cwd() !== root) throw new Error('Run the build from the package root');
const output = resolve(root, 'lib');
try {
  const info = await lstat(output);
  if (info.isSymbolicLink() || await realpath(output) !== resolve(await realpath(root), 'lib')) throw new Error('Refusing to clean a linked output directory');
  console.log('Clean package-owned build output:', output);
  await rm(output, { recursive: true });
} catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
await import('./generate-remote.mjs');
await mkdir('lib', { recursive: true });
const input = ts.readConfigFile('tsconfig.declarations.json', ts.sys.readFile);
if (input.error) throw new Error(ts.flattenDiagnosticMessageText(input.error.messageText, '\n'));
const config = ts.parseJsonConfigFileContent(input.config, ts.sys, process.cwd());
const program = ts.createProgram(config.fileNames, config.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n' }));
  process.exitCode = 1;
} else {
  program.emit();
  await build({ entryPoints: ['src/generated/typert.host.ts', 'src/generated/typert.remote-client.ts'], outdir: 'lib/generated', bundle: true, platform: 'neutral', format: 'esm', target: 'es2022', packages: 'external' });
  await build({ entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true });
  await build({ entryPoints: ['src/client.ts'], outfile: 'lib/client.js', bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', external: ['react'],
    banner: { js: 'window.__ModuleLoader__.load({id:"dsh-opendesign-corouter",factory:(require)=>{var module={exports:{}};var exports=module.exports;' }, footer: { js: 'return module.exports;}});' } });
  console.log('Built Host bundle, declarations and lazy Client module.');
}
