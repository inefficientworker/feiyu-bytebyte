# Chrome 实际验收记录

日期：2026-11-23。浏览器：用户当前 Chrome，ScriptCat 1.5.2。使用 Chrome MCP 检查真实评论 DOM、点击现有控件，使用桌面工具操作脚本管理器的安装和菜单。未使用 Playwright、模拟评论或自动化 E2E 框架。

## 0.1.1：高赞评论豁免

已更新当前 Chrome 的 ScriptCat。真实页面 [BV1JGyxzKEyf](https://www.bilibili.com/video/BV1JGyxzKEyf/) 中，“小肥鱼在打工”的 8 赞回复和“旁观者的大肥鱼”的 155 赞主评论保持显示；同一账号的 2 赞回复仍折叠。

另外仅在真实页面本地临时修改该 8 赞回复的计数文字，依次检查 5 → 6 → 5：折叠 → 恢复 → 折叠。已恢复原始 8 赞文字，评论也恢复显示；未发送任何点赞请求。见 [likes-exemption.json](./likes-exemption.json) 和 [likes-exemption.png](./likes-exemption.png)。

## 0.1.0 初始验证（以下高赞评论行为已由 0.1.1 更新）

1. 在 [BV1BHyDzKEPp](https://www.bilibili.com/video/BV1BHyDzKEPp/) 切换“最新”：截图中的“贪吃的小鱼儿”和“小鱼不加班_Channel”分别以 104.8 / 109.7 分折叠。中间“清晨的苏”的评论正文虽 @ 了肥鱼账号，仍显示。见 [folded.png](./folded.png) 和 [first-run.json](./first-run.json)。
2. 点击“展开评论”后 `aria-expanded=true`，原评论 body 从 `display:none` 恢复为 `block`，评分明细显示；再次收起恢复 `none`。最终版本的展开截图见 [expanded.png](./expanded.png)。
3. 将“贪吃的小鱼儿”加入白名单后立即恢复，刷新仍保持显示；另一个账号仍折叠。刷新后 `inferences=0`、`downloads=[]`，证明已有头像概率复用。见 [reload-whitelist.json](./reload-whitelist.json)。验收完成后已从自定义白名单移除此测试账号。
4. 滚动后新加载的“六年的大肥鱼”自动以约 114.7 分折叠。
5. 在 [BV1JGyxzKEyf](https://www.bilibili.com/video/BV1JGyxzKEyf/) 发现典型账号 `630922438`“小肥鱼在打工”的多条真实楼中楼回复，约 99.7 分，分别折叠，其他人的回复保留。“旁观者的大肥鱼”的主评论也折叠。最终版本刷新后再次验证楼中楼展开 / 收起：见 [nested-replies.json](./nested-replies.json) 与 [nested-replies.png](./nested-replies.png)。
6. 在 [DeepSeekHarness 入驻视频](https://www.bilibili.com/video/BV1i24P6rEmt/) 看到其真实评论，状态为 `whitelist`，未折叠。见 [protected-account.json](./protected-account.json)。
7. ScriptCat 实际从镜像下载模型，校验并保存缓存，未报错。在新视频遇到新头像时加载缓存，状态为“已校验缓存 SHA-256”，没有模型下载，完成新头像推理。见 [model-cache.json](./model-cache.json)。
8. 另用 Chrome 页面内 ONNX Runtime 直接从 Hugging Face 官网下载同一模型，SHA-256 与脚本固定值相同。以其识别搜索页的 25 个头像及截图新增的两个头像。见 [avatar-samples.json](./avatar-samples.json)。典型账号头像概率约 99.51%，见 [typical-account.json](./typical-account.json)。

## 真人对照与范围

- `3747571004608077`：头像模型概率约 99.89%，按一般评分会误折叠。已按用户给定真人身份加入内置白名单，并验证其真实评论被保护。
- `518791169`：头像模型概率约 2.98%，低于最低门槛；同样内置保护。浏览了其一个视频，该页三条评论中未出现本人的评论，未伪造评论补测。
- 模型分数因浏览器 Canvas 实现和扩展可能有极小差异；`first-run.json` 为正式安装脚本的实际值，`avatar-samples.json` 为页面内头像对照推理值。
- 镜像与官网都成功下载过同哈希模型；未通过故障注入验收自动切换、缓存损坏和离线分支。代码对这三种情况保留评论，提供重试。
- 当前主要验证桌面视频页的 Shadow DOM 评论组件。动态页、旧版评论 DOM 和 Tampermonkey 尚未单独运行验收。

复现时从上述视频的“最新 / 最热”评论切换并滚动至对应账号，打开脚本菜单的“运行状态 / 评分明细”查看模型来源、缓存状态和逐条评分。评论排序、数量和账号资料会随网站变化。
