# 项目交付约定

- 每次完成代码修改并通过相应验证后，执行 `npm run package`，生成最新的 Windows x64 安装包。
- 打包成功后自动静默安装最新版本，默认使用 `node scripts/reinstall.cjs`，保留现有用户数据，安装后核验实际安装版本。用户已授权此交付流程，后续无需再次询问是否安装。
- 交付时提供 `release/PersonalWorkbench-<package.json 中的版本>-Setup.exe` 的绝对路径链接；打包失败时先排查并修复，确有阻碍时如实说明。

# 测试与验证分级

- 本项目全量 `npm test` 串行包含 120+ 项 Git / Tomcat / Spring 重型集成测试，单次耗时约 15 分钟；`scripts/verify-*.cjs` 为真实 Electron 自动化验收脚本，单次耗时 1～2 分钟。
- 开发与修改验证阶段，优先定向编译并只跑改动直接涉及的单测文件（例如 `tsc -p tsconfig.test.json` 后执行 `node --test .local/tests/tests/<对应文件>.test.js`）及直接关联的单个 `verify-*.cjs`。
- 仅在涉及跨模块公共底层改动且准备最终打包前，最多执行 1 次全量 `npm test`；局部页面或单模块修改无需跑全量 `npm test` 与无关的 `verify-*.cjs`。
