#!/bin/sh
set -eu
task_target=${1-}
case "$task_target" in test|prod|callback) ;; *) printf '%s\n' '用法：sh uploadCloudFunction.sh test|prod|callback [--dry-run]' >&2; exit 2 ;; esac
if [ "$#" -gt 2 ] || { [ "$#" -eq 2 ] && [ "$2" != '--dry-run' ]; }; then
  printf '%s\n' '仅支持明确的部署目标及可选 --dry-run 参数' >&2; exit 2
fi
task_project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$task_project_dir"
if [ "${2-}" = '--dry-run' ]; then node scripts/cloud-build.js "$task_target"; exit 0; fi
: "${WECHAT_DEVTOOLS_CLI:?请设置微信开发者工具 CLI 的绝对路径}"
task_cloud_env=$(node -p "require('./server/stages.json').cloudEnv")
if [ -n "${WECHAT_CLOUD_ENV-}" ] && [ "$WECHAT_CLOUD_ENV" != "$task_cloud_env" ]; then
  printf '%s\n' '云环境与项目配置不一致，已停止部署' >&2; exit 2
fi
npm run prepare:cloud
npm run release:check
task_function_names=$(node scripts/cloud-build.js "$task_target" --names)
for function_name in $task_function_names; do
  "$WECHAT_DEVTOOLS_CLI" cloud functions deploy --e "$task_cloud_env" --n "$function_name" --r --project "$task_project_dir"
done
