# 项目交付约定

- 每次完成代码修改并通过相应验证后，执行 `npm run package`，生成最新的 Windows x64 安装包。
- 打包成功后自动静默安装最新版本，默认使用 `node scripts/reinstall.cjs`，保留现有用户数据，安装后核验实际安装版本。用户已授权此交付流程，后续无需再次询问是否安装。
- 交付时提供 `release/PersonalWorkbench-<package.json 中的版本>-Setup.exe` 的绝对路径链接；打包失败时先排查并修复，确有阻碍时如实说明。
