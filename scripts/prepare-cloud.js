const fs = require('fs'),
  path = require('path'),
  build = require('./cloud-build');
const {
  root
} = build;
for (const name of ['domain', 'account', 'guidance', 'daily', 'nutrition', 'workout']) fs.copyFileSync(path.join(root, 'shared', name + '.js'), path.join(root, 'miniprogram/shared', name + '.js'));
const clientManifest = 'module.exports = ' + JSON.stringify(build.manifest, null, 2) + ';\n';
fs.writeFileSync(path.join(root, 'miniprogram/shared/stages.js'), clientManifest);
const legacyClientManifest = path.join(root, 'miniprogram/shared/stages.json');
if (fs.existsSync(legacyClientManifest)) fs.unlinkSync(legacyClientManifest);
const version = build.sourceVersion();
for (const entry of build.entries()) {
  const dir = path.join(root, 'cloudfunctions', entry.name);
  fs.mkdirSync(path.join(dir, 'lib'), {
    recursive: true
  });
  fs.copyFileSync(path.join(root, 'server/entries', entry.entry + '.js'), path.join(dir, 'index.js'));
  for (const name of fs.readdirSync(path.join(root, 'server'))) {
    const file = path.join(root, 'server', name);
    if (fs.statSync(file).isFile() && /\.(js|json)$/.test(name) && !['domain.js', 'account.js', 'daily.js', 'nutrition.js'].includes(name)) fs.copyFileSync(file, path.join(dir, 'lib', name));
  }
  for (const name of ['domain', 'account', 'guidance', 'daily', 'nutrition', 'workout']) fs.copyFileSync(path.join(root, 'shared', name + '.js'), path.join(dir, 'lib', name + '.js'));
  fs.writeFileSync(path.join(dir, 'deployment.json'), JSON.stringify({
    ...entry,
    sourceVersion: version
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: entry.name.toLowerCase(),
    version: '1.0.0',
    main: 'index.js',
    dependencies: {
      'wx-server-sdk': entry.entry === 'coach' ? '3.0.5-beta.1' : '~2.4.0'
    }
  }, null, 2) + '\n');
  const config = entry.entry === 'reminderJob' ? {
    triggers: [{
      name: 'coach-reminders-' + entry.stage,
      type: 'timer',
      config: '0 */5 * * * * *'
    }]
  } : {};
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}
console.log('Generated', build.entries().length, 'cloud functions; source version', version);
