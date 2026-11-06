const fs = require('fs'),
  path = require('path'),
  cp = require('child_process');
const root = path.resolve(__dirname, '..');
let count = 0;

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', '.git'].includes(name)) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) {
      cp.execFileSync(process.execPath, ['--check', p], {
        stdio: 'pipe'
      });
      count++;
    } else if (p.endsWith('.json')) JSON.parse(fs.readFileSync(p, 'utf8'));
  }
}
walk(root);
const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json')));
for (const page of app.pages)
  for (const ext of ['js', 'json', 'wxml', 'wxss'])
    if (!fs.existsSync(path.join(root, 'miniprogram', page + '.' + ext))) throw new Error('Missing page ' + page + '.' + ext);
const build = require('./cloud-build');
for (const target of ['miniprogram/shared/domain.js', ...build.entries().map(e => 'cloudfunctions/' + e.name + '/lib/domain.js')])
  if (fs.readFileSync(path.join(root, target), 'utf8') !== fs.readFileSync(path.join(root, 'shared/domain.js'), 'utf8')) throw new Error('Stale domain: ' + target);
for (const entry of build.entries()) {
  const dir = path.join(root, 'cloudfunctions', entry.name),
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'deployment.json')));
  if (meta.stage !== entry.stage || meta.entry !== entry.entry || meta.sourceVersion !== build.sourceVersion()) throw new Error('Stale deployment: ' + entry.name);
  if (fs.readFileSync(path.join(dir, 'index.js'), 'utf8') !== fs.readFileSync(path.join(root, 'server/entries', entry.entry + '.js'), 'utf8')) throw new Error('Stale entry: ' + entry.name);
  for (const name of fs.readdirSync(path.join(root, 'server')))
    if (/\.(js|json)$/.test(name) && !['domain.js', 'account.js', 'guidance.js', 'daily.js', 'nutrition.js', 'workout.js'].includes(name)) {
      if (fs.readFileSync(path.join(dir, 'lib', name), 'utf8') !== fs.readFileSync(path.join(root, 'server', name), 'utf8')) throw new Error('Stale library: ' + entry.name + '/' + name);
    }
}
for (const target of ['miniprogram/shared/account.js', ...build.entries().map(e => 'cloudfunctions/' + e.name + '/lib/account.js')])
  if (fs.readFileSync(path.join(root, target), 'utf8') !== fs.readFileSync(path.join(root, 'shared/account.js'), 'utf8')) throw new Error('Stale account module: ' + target);
for (const target of ['miniprogram/shared/guidance.js', ...build.entries().map(e=>'cloudfunctions/'+e.name+'/lib/guidance.js')]) if(fs.readFileSync(path.join(root,target),'utf8')!==fs.readFileSync(path.join(root,'shared/guidance.js'),'utf8')) throw new Error('Stale guidance: '+target);
for (const target of ['miniprogram/shared/daily.js', ...build.entries().map(e=>'cloudfunctions/'+e.name+'/lib/daily.js')]) if(fs.readFileSync(path.join(root,target),'utf8')!==fs.readFileSync(path.join(root,'shared/daily.js'),'utf8')) throw new Error('Stale daily rules: '+target);
for(const target of ['miniprogram/shared/nutrition.js',...build.entries().map(e=>'cloudfunctions/'+e.name+'/lib/nutrition.js')]) if(fs.readFileSync(path.join(root,target),'utf8')!==fs.readFileSync(path.join(root,'shared/nutrition.js'),'utf8')) throw new Error('Stale nutrition: '+target);
const clientManifest = 'module.exports = ' + JSON.stringify(build.manifest, null, 2) + ';\n';
for (const target of ['miniprogram/shared/workout.js', ...build.entries().map(e=>'cloudfunctions/'+e.name+'/lib/workout.js')])
  if(fs.readFileSync(path.join(root,target),'utf8')!==fs.readFileSync(path.join(root,'shared/workout.js'),'utf8'))throw new Error('Stale workout rules: '+target);
if (fs.readFileSync(path.join(root, 'miniprogram/shared/stages.js'), 'utf8') !== clientManifest) throw new Error('Stale client stage manifest');
console.log('Syntax/JSON/routes/shared copies OK:', count, 'JavaScript files.');
const native = '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec';
if (fs.existsSync(path.join(native, 'wcc'))) {
  const os = require('os');
  cp.execFileSync(path.join(native, 'wcc'), ['-o', path.join(os.tmpdir(), 'boji-wxml-check.js'), ...app.pages.map(p => p + '.wxml')], {
    cwd: path.join(root, 'miniprogram')
  });
  cp.execFileSync(path.join(native, 'wcsc'), ['-o', path.join(os.tmpdir(), 'boji-wxss-check.js'), 'app.wxss'], {
    cwd: path.join(root, 'miniprogram')
  });
  console.log('Native WXML/WXSS compilation OK.');
}
