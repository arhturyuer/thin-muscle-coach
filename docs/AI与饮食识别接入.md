# CloudBase 国内站 AI 与饮食识别

**最新更正与成功验证：** 已改用支持图片且可抵扣成长计划额度的 deepseek-v4.1-flash，并通过官方云函数 SDK 完成真实识别。此前“赠送额度不支持照片识别”的结论有误；详见 [DeepSeek 图片识别接入](DeepSeek图片识别接入-2026-11-03.md)。下文保留历史排查经过。


最新功能已扩展为大模型三餐食谱与照片营养分析，当前行为见 [三餐食谱与照片营养分析](三餐食谱与照片营养分析.md)。下文的“只含名称与份量”描述保留为最初接入记录，不代表最新产品能力。

2026-11-03：按用户最新要求，文字指导与饮食照片识别统一使用腾讯云 CloudBase 国内站 AI 网关。此前 DeepSeek / 百炼直连方案已替换，无需单独开通两家 API。

## 已完成

- CloudBase 官方插件 0.2.2 已通过官方 CNB 镜像安装至 Codex 用户范围，含 32 个技能和 MCP 配置。重启 Codex 后加载 MCP，本轮使用官方 CLI 与已有微信开发者工具 CLI。
- 国内站信息已记录在 `.cloudbase/project.json`，复用环境 `cloud1-d2glj4fu92e8f1497`。
- 控制台已核实网关地址和现有 API Key「第一个」。coach_test 已选择该 Key 自动注入为 `CLOUDBASE_APIKEY`，未创建或替换密钥。
- coach_test 的 AI_READY、MEAL_RECOGNITION_READY 已设置 true，超时已保存为 60 秒。原四项支付凭据保留。
- 代码统一使用该环境的 `/v1/ai/cloudbase/chat/completions`；地址校验拒绝第三方、其他环境、用户名密码及查询参数。
- 180 项自动测试、release:check、微信原生 WXML/WXSS 编译通过。
- coach_test 上传成功（官方 CLI success=true），部署包 sourceVersion=b2a2eb94c66a146c。正式函数、任务和共享回调本轮未部署。

## 配置

| 环境变量 | 用途 |
| --- | --- |
| CLOUDBASE_APIKEY | 控制台「API Key 设置」自动注入，推荐；不在仓库或前端存放 |
| CLOUDBASE_AI_API_KEY | 可选手动注入，优先于上项；无需与自动注入重复设置 |
| CLOUDBASE_AI_BASE_URL | 可选，缺省为当前项目网关；若设置必须与当前环境严格一致 |
| CLOUDBASE_AI_TEXT_MODEL | 可选，缺省 hy3；以后台实际启用及授权的模型为准 |
| CLOUDBASE_AI_VISION_MODEL | 可选，缺省 hy-vision-2.0-instruct；必须使用支持图片输入且后台已授权的模型 |
| AI_READY | true 开放文字指导 |
| MEAL_RECOGNITION_READY | true 开放饮食照片识别 |

模型需要在 CloudBase 后台具备可用额度与调用资格。API Key 存在不代表模型和资源配额已完成验证。本轮没有购买套餐、充值或变更计费方案。后台显示当前为旧版个人套餐；小程序成长计划赠送资源的适用调用来源以平台实际返回为准。

两个模型请求都有 25 秒总超时，不透传供应商错误正文、密钥或完整请求。未配置时保持不可用，不切回旧供应商。setup.status 仅在 test 返回缺项名称。

## 产品流程与限制

文字指导维持每天 30 次成功回复，失败不扣次数、历史可恢复、计划调整需用户复评确认。提问前同意将必要的身体摘要、计划、近期记录和问题交由腾讯云 CloudBase AI 处理。

饮食页拍照保留本机原件，点击「识别食物」并同意后，压缩照片经云函数发送给 CloudBase AI；不附带身体资料，不持久化图片或创建公开图片链接。每图最多 600 KB，服务端校验文件头、编码及大小。

结果只含食物名称和日常单位的粗略份量，可修改、选择餐次后填入草稿；点击保存才记录与同步，不自动完成饮食任务。每日最多 20 次成功识别，独立于聊天额度；重复请求复用结果，失败不扣次，同账号一次只识别一张。结果和次数使用原 guidance 辅助集合，随个人数据删除清除，进行中结果有删除保护。

照片不能可靠确定用油、过敏原、食品安全或精确份量；界面提示核对，不生成营养处方。

## 尚待真实验收

- [ ] 从已付测试会员的小程序运行时刷新配置，确认 aiEnabled / mealRecognitionEnabled。
- [ ] 发送一次实际 AI 提问，核验结构化回复、额度、历史恢复。
- [ ] 识别一张真实饮食照片，修改、选择餐次、保存并同步。
- [ ] 核验实际模型权限、配额、超时与错误反馈，必要时根据后台已启用模型调整模型名。
- [ ] 微信后台隐私指引与算法合作协议按实际 AI 服务补齐，再推进正式发布。

微信开发者工具的 UI 自动化连接本轮超时，未完成上述真机/运行时验收，不将自动化替身测试当作真实模型调用。

## CLI 登录说明

官方 CloudBase CLI 3.8.11 能登录国内站，但机器上原有登录列出的环境不含本项目；指定项目查询返回 GET_ENV_DETAIL_FAILED（env not found in list）。普通 login 检测已有登录后直接跳过。没有修改其他环境或销毁登录。本轮通过已有正确登录的浏览器配置本项目，并通过微信官方 CLI 部署到明确环境。

后续使用 MCP 管理本环境时，需授权拥有该环境权限的账号或按官方流程使用该环境 API Key 登录；不要把旧账号下其他环境当成本项目。

参考：[官方接入技能](https://docs.cloudbase.net/skill.md)、[CloudBase HTTP AI 接口](https://docs.cloudbase.net/ai/model/curl-access)、[多模态理解](https://docs.cloudbase.net/ai/model/multimodal)。
