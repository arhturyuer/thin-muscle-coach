# 自然周运动方案

运动方案独立于饮食计划和原有七天训练权益，以北京时间周一至周日归档。小程序 bootstrap 同步评测和记录后调用 ensure；确认付款、会员完成评测也调用相同入口。未同步的评测或运动记录、相关冲突会阻止自动生成，避免使用旧数据。

## 接口

- `workout.plan.ensure({requestId})`：要求有效会员及适用评测。返回 `{status, plan, message, assessmentKey}`；同周同评测复用方案，其他正在生成的请求返回 `generating`。AI 不可用或结果校验失败返回 `AI_UNAVAILABLE`，页面保留已有方案并显示重试。
- `workout.plan.get({from, to})`：最多读取 42 个自然日，返回 `{plans, states, legacyPlans}`。历史查看不要求当前会员有效。记录日期选择其绑定的不可变方案版本。
- `sync.batch` 新增 `workoutRecord`，记录 key 为 `workout:YYYY-MM-DD`，继续使用 `baseVersion` 乐观锁、操作幂等和本地离线队列。

方案保存在已有分区的 guidance 辅助集合，key 为 `workout:<周一日期>`，包含当前方案、历史版本和生成锁；不需要新增数据库集合或调整客户端数据库权限。云函数使用可信 OPENID 访问所属用户数据。删除账号沿用现有辅助数据清理流程。

## 数据约定

- 方案：`id`、`version`、`weekStart`、`weekEnd`、`generatedAt`、`days`。
- 每天：`date`、`planVersion`、`title`、`reason`、`rest`、`seconds`、`energyKcal`、`estimate`、`exercises`。
- 动作：版本内稳定的 `id`、`name`、`cue`、`equipment`、`mode`、`sets`、`reps`、`seconds`。计时动作 `reps=null`，动作 `seconds` 是所有组活动时间合计；每天 `seconds` 包含休息。热量是训练净活动消耗估算，不含步行。
- 记录：`planId`、`planVersion`、`date`、`status`（`completed` / `partial` / `recovery`）、动作实际量、`completedSets`、`seconds`、`difficulty`、`discomfort`、`at`。记录总时长是各动作实际时长之和。

标题最多 18 字符、安排逻辑最多 60 字符，界面分别限制一行和两行。动作不限固定库，但必须有文字指导并满足当前器械条件、单次时长和训练量边界。匹配旧动作名称时可复用已有视频。

重新评测只更新当天及未来未记录日期。AI 返回后在事务内再次检查评测版本、会员、日期和已记录日期；跨日期、过期锁或失效评测的结果不写入。历史方案版本允许记录在生成并发后仍绑定原始动作；历史记录读取优先选择该版本。实际填写超出计划允许如实记录，不将计划量强行作为实际完成量。

新记录按日期替代旧 session 的统计；不从旧记录推算逐动作次数。旧计时训练可继续完成，新入口进入手动记录页。

## 验证与上线

本地：`npm run prepare:cloud`、`npm test`、`npm run check`。新增测试见 `tests/workout-plan.test.js` 和 `tests/workout-client.test.js`；编译检查包括 WXML/WXSS。

先发布对应分区的 coach 云函数，再发布小程序，bootstrap 的 `workoutPlansSupported` 标记开启新流程。现有辅助集合和 AI 通道可直接复用，不要求迁移原有饮食方案或历史记录。

2026-11-04 已部署测试区 `coach_test` 与 `reminderJob_test`，版本 `638a3eb687fd4cfa`，两者状态均为 Active。已使用目标环境所属账号核验环境与 AI 资源，并完成真实付费测试账号的周方案生成：返回 ready，保存当天至周日的完整安排，可训练日校验通过。正式区、共享支付回调及小程序体验版未发布。详细结果见 [部署记录](部署记录-2026-11-04-运动计划.md)。

296 项自动化测试及编译检查通过；微信开发者工具已用隔离离线数据验证卡片跳转、详情和记录页展示，以及提交 1 组 / 60 秒后保存部分完成记录、写入离线队列并返回详情页的流程。验证后恢复原本的本地数据。真实 AI 联调发现的星期推断问题已修复：服务器提供逐日日期、星期与可训练标记，模型直接使用该日历，服务端继续严格校验；诊断仅保存允许列表内的错误分类，不记录模型原文。
