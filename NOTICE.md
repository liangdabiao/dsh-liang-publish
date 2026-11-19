# 第三方代码声明（NOTICE）

本插件包含移植自下列上游项目的代码与规则，按其许可证要求保留声明：

## mdldm-maitian-publisher（Apache License 2.0）

- 来源：https://github.com/CzzzzzzJ/mdldm-maitian-publisher
- 移植内容：`lib/vendor/bundle.mjs`（publish.json 校验规则，来自 lib/bundle.js，本仓库保留全部平台规则并按 v1 范围启用国内四平台）；`lib/adapters/*` 与 `lib/engine.js` 的填写顺序、校验点与状态机语义（来自 lib/publish.js 与 lib/platforms/*，操作原语从 chrome.debugger/evaluate 重写为 browser-skill CLI）。
- Apache-2.0 全文见上游仓库；本插件整体按 MIT 分发，本文件即为对上述内容的归属声明。

## mdldm-maitian（MIT License）

- 来源：https://github.com/CzzzzzzJ/mdldm-maitian
- 移植内容：`lib/db.mjs` 的表结构与防重状态机（来自 src/db.mjs）；`lib/review.js` 的复盘算法（来自 src/review.mjs，去知识站转化部分）；防风控纪律文案（README「各平台的坑」）。

感谢原作者（麦当 mdldm）的开源工作。
