const cloud = require('wx-server-sdk'),
  deployment = require('../deployment.json'),
  {
    createRuntime
  } = require('./runtime-factory');
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  timeout: 60000
});
if (deployment.stage === 'callback') {
  module.exports = {
    cloud,
    stage: 'callback',
    sourceVersion: deployment.sourceVersion,
    forStage: stage => createRuntime(cloud, stage)
  };
} else {
  module.exports = {
    ...createRuntime(cloud, deployment.stage),
    sourceVersion: deployment.sourceVersion
  };
}
