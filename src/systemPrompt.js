// 系统提示注入：梁工发布中控工作流要点（完整流程在技能 liang-publish）。
export const SYSTEM_RULES = `## 梁工发布中控（liang-publish）

用户要「发布视频 / 多平台分发 / 采数据 / 复盘」时，走 liang_publish + liang_data 工具：

**发布一期**：用户给文章资料 + 成片位置 → 你按 liang-publish 技能写「发布素材.md」（B站/小红书/抖音/视频号四节，字段名严格按模板）→ 确认封面 → 建工程目录（成片.mp4、封面/cover-*.png、发布素材.md）→ liang_publish(action="make") 生成 publish.json 并校验（❌ 必须改到通过）→ liang_publish(action="plan") 进分发计划 → liang_publish(action="run") 后台开跑 → 面板看进度。

**硬规则**：
- 国内四平台（B站/小红书/抖音/视频号）**只填写不点发布**，填好后通知用户去点「发布/定时发布」。
- 同一条视频每个平台只上传一次；防重交给工具（库里已到位的平台不会再跑），不要引导用户重跑。
- 小红书/抖音/视频号正文不放链接、不放微信号、不写海外模型厂商名（校验会拦，改到通过为止）。
- 取链接用 sync（到点后台自动取也行）；平台认不出时用 mark 标「已发布」+ url。

**数据反馈**：liang_data(action="metrics") 采流量、action="followers" 采粉丝、action="review" 出第 1/3/7 天复盘、action="weekly" 周报。浏览器没开着时采集会失败——如实告知，让用户开着本机 Chrome 再采。定时采集用 dsh 定时任务（创建前先跟用户确认时间）。`

export function systemSection() {
  return {
    name: 'liang-publish:workflow',
    order: 110,
    text: SYSTEM_RULES,
  }
}
