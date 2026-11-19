# 梁工发布中控（dsh-liang-publish）

一期视频，发四个平台（**B站 / 小红书 / 抖音 / 视频号**），发完自动记数据、出复盘。

**核心原则：只填写，不点发布。** 国内四家最后的「发布 / 定时发布」永远由你自己点——防重、防风控是产品底线。

```
你给文章资料 + 成片位置
      ↓
AI 写四平台文案（发布素材.md）→ 建工程 → 生成 publish.json + 校验
      ↓
一键开跑：程序在你【本机 Chrome】的后台窗口里填好四个平台的上传页
（传视频、传封面、写标题正文、选话题、设定时）
      ↓
四平台「填好就停」→ 你去点发布 → 到点自动回收链接
      ↓
每天采流量/粉丝 → 大屏看板 → 第 1/3/7 天自动复盘
```

## 安装

```bash
dsh plugin --profile web add https://github.com/liangdabiao/dsh-liang-publish
```

## 前置条件（一次性配置）

| 项 | 说明 |
|---|---|
| **本机 Chrome + BrowserSkill 扩展** | 插件通过 [browser-skill（bsk）](https://github.com/Tencent/BrowserSkill) 扩展通道控制**你已登录的日常 Chrome**——不新开浏览器、不存任何平台密码。Chrome 136+ 已禁止遥控默认浏览器的旧通道，bsk 扩展通道是唯一正解。 |
| **bsk 守护进程常驻** | 在独立终端跑 `bsk daemon start --foreground`（建议挂开机任务）；任务跑的时候 Chrome 要开着。 |
| **平台登录态** | 在本机 Chrome 里登录 B站/抖音/小红书/视频号的创作者后台，面板点「🩺 登录体检」确认。 |
| **插件配置** | `rootPath`：发布工程根目录（如 `D:\视频导出`），每期一个子目录。 |

## 使用（对话里）

跟 AI 说「帮我发布这期视频」，给它文章资料和成片位置。AI 按 `liang-publish` 技能走流程：

1. **写发布素材.md**（B站/小红书/抖音/视频号四节，模板见技能）
2. **建工程目录**：`<rootPath>/<系列>/<期>/` 放 `成片.mp4`（必须 faststart）、`封面/cover-3x4.png`、`cover-4x3.png`
3. `liang_publish(action="make")` 生成 publish.json 并校验（字数、禁词、链接、faststart）
4. `liang_publish(action="plan")` 进分发计划 → `liang_publish(action="run")` 后台开跑
5. 你去各平台点「发布 / 定时发布」（能勾原创的都勾上）
6. `liang_publish(action="sync")` 取链接回填

数据反馈：`liang_data(action="metrics"|"followers"|"review"|"weekly")`。定时采集用 dsh 定时任务（浏览器没开着当天就跳过）。

## 面板

侧栏「梁工发布中控」：粉丝卡 + 期数列表（每期四平台状态/数据/链接）+ 后台任务实时日志 + 一键操作（取链接/采流量/复盘/标记已发布）。

## 工具一览

| 工具 | action | 干什么 |
|---|---|---|
| `liang_publish` | make / plan / run / sync / mark / adopt / status / doctor | 发布全流程 |
| `liang_data` | metrics / followers / review / weekly | 数据反馈 |

## 防风控纪律（上游实战总结，全部保留）

- 同一条视频每个平台**只上传一次**；库里已到位的平台不再跑，重跑必须先去平台确认没发出去
- 小红书只读页面、低频，不碰它的接口
- 四家最后的发布永远是人点
- 只操作你自己的账号，不做互动自动化

## 工程结构

```
lib/vendor/bundle.mjs   publish.json 校验规则（平台字数/禁词/标签，快照移植）
lib/bsk.js              bsk 桥（唯一通道）：real=spawn bsk CLI，mock=页面状态机
lib/adapters/           四平台填写适配器（bsk 原语：upload/fill/click/snapshot ref）
lib/engine.js           发布编排：预检登录 → 逐平台填写 → 等上传 → 补封面
lib/collectors.js       取链接/流量/粉丝（作品管理页 DOM 读数）
lib/hubops.js           高层操作（接 DB 与状态机）
lib/review.js           复盘算法（同龄对比/互动率/涨粉）
src/host.js             工具注册 + 技能提供方 + 面板数据面
lab/                    面板页面（粉丝卡/期数列表/任务日志）
skills/liang-publish/   发布工作流技能
```

## 真机校准

适配器里标 `⚠️校准` 的定位器按 bsk aria snapshot 的真实结构核对后即可上真机；所有 bsk CLI 细节集中在 `lib/bsk.js` 的 real 后端，校准不动适配器。离线回归基准在 `test/mocks.mjs`（页面状态机），跑 `npm test` + `npm run smoke` 不碰真实浏览器。

## 致谢与许可

发布方法论与校验规则移植自 [CzzzzzzJ/mdldm-maitian](https://github.com/CzzzzzzJ/mdldm-maitian)（MIT）与 [CzzzzzzJ/mdldm-maitian-publisher](https://github.com/CzzzzzzJ/mdldm-maitian-publisher)（Apache-2.0），详见 [NOTICE.md](NOTICE.md)。本项目 MIT。
