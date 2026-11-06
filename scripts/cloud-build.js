const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto'),
  manifest = require('../server/stages.json');
const root = path.resolve(__dirname, '..');

function entries() {
  return [
    ...Object.entries(manifest.stages).flatMap(([stage, cfg]) => [{
      name: cfg.functionName,
      stage,
      entry: 'coach'
    }, {
      name: cfg.reminderFunction,
      stage,
      entry: 'reminderJob'
    }]),
    {
      name: manifest.callbackFunction,
      stage: 'callback',
      entry: 'paymentCallback'
    }
  ];
}

function sourceVersion() {
  const files = [];

  function walk(dir) {
    for (const name of fs.readdirSync(path.join(root, dir)).sort()) {
      const relative = path.join(dir, name);
      if (fs.statSync(path.join(root, relative)).isDirectory()) walk(relative);
      else files.push(relative);
    }
  }
  walk('server');
  files.push('shared/workout.js', 'shared/nutrition.js', 'shared/daily.js', 'shared/domain.js', 'shared/account.js', 'shared/guidance.js', 'scripts/prepare-cloud.js', 'scripts/cloud-build.js');
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) hash.update(file + '\0').update(fs.readFileSync(path.join(root, file))).update('\0');
  return hash.digest('hex').slice(0, 16);
}

function target(name) {
  if (!['test', 'prod', 'callback'].includes(name)) throw new Error('必须明确选择部署目标：test、prod 或 callback');
  return {
    target: name,
    cloudEnv: manifest.cloudEnv,
    functions: entries().filter(e => e.stage === name).map(e => e.name),
    sourceVersion: sourceVersion()
  };
}
module.exports = {
  root,
  manifest,
  entries,
  sourceVersion,
  target
};
if (require.main === module) {
  try {
    const plan = target(process.argv[2]);
    console.log(process.argv.includes('--names') ? plan.functions.join('\n') : JSON.stringify(plan, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
