// The cloud environment is shared. Runtime versions select immutable service partitions.
module.exports = {
  cloudEnv: require('../shared/stages').cloudEnv
};
