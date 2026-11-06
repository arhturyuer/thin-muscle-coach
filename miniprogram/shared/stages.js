module.exports = {
  "cloudEnv": "cloud1-d2glj4fu92e8f1497",
  "versions": {
    "develop": "test",
    "trial": "prod",
    "release": "prod"
  },
  "stages": {
    "test": {
      "functionName": "coach_test",
      "reminderFunction": "reminderJob_test",
      "accounts": "coach_test_accounts",
      "orders": "coach_test_order_index",
      "storagePrefix": "test/",
      "cachePrefix": "coach:test:",
      "orderPrefix": "bjt"
    },
    "prod": {
      "functionName": "coach_prod",
      "reminderFunction": "reminderJob_prod",
      "accounts": "coach_accounts",
      "orders": "coach_order_index",
      "storagePrefix": "prod/",
      "cachePrefix": "coach:prod:",
      "orderPrefix": "bjp"
    }
  },
  "callbackFunction": "paymentCallback",
  "storageFilePrefix": "cloud://cloud1-d2glj4fu92e8f1497.636c-cloud1-d2glj4fu92e8f1497-1359464461/"
};
