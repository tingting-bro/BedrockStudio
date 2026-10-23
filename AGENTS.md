# 项目协作约定

适用于整个项目；用户最新明确要求优先。中文简洁沟通，没有自动延续的开发待办。

## 工作与上下文

- 先按任务搜索相关源码，再读必要片段；不默认通读 README、交接档案或全项目。
- 默认使用本地文件和终端；只调用当前任务必需的工具、MCP 和技能，不为简单任务加载额外技能。遵守上层必须使用技能的要求。
- 不默认使用子代理；仅用户明确要求时使用。新交互或效果不明确时先澄清，已确认行为不反复询问。
- 搜索限定相关源码或测试目录，避开 `node_modules/`、`dist/`、资源包、参考仓库、归档和缓存；仅资源任务按需检索资源。
- 长输出先过滤、限制行数；不反复读取相同文件，不无理由重复测试或重装依赖。完成后只报告实际改动、验证和必要限制。
- 长期规则留在本文件；详细设计、模块索引和历史验证放 `_references/docs/`，不再将逐轮日志追加到这里。

## 环境与目录

- 系统 Python 3.12.10：`E:\Python\Python312\python.exe`；不创建、激活或恢复虚拟环境，不加 `sys.path` / `PYTHONPATH` 补丁。
- 后端 `code/backend/src/bedrock_editor/`：FastAPI、nbtlib、pywebview；前端 `code/frontend/src/`：React、TypeScript、Vite。沿用现有架构。
- 根目录唯一启动入口 `start.py`；自有代码/配置/说明在 `code/`，测试与研究在 `_references/`。不新增根目录临时脚本、日志或测试；项目级工具配置在 `.codex/`。
- 不改生成结果、第三方代码或归档环境实现功能；不移动 `code/backend/src`。不要反复清理 IDE 自动生成的 `.idea`。Git 状态先核实，不假定已有仓库。
- Vite `publicDir` 是 `code/resource_packs`，不另建 `frontend/public`。资源按需重建，不默认下载。依赖更新写对应 manifest/lockfile。

## 验证边界

- 默认仅逻辑测试、静态检查和构建；除非用户明确要求，不启动桌面、服务、开发服务器、浏览器或 UI 自动化。`start.py --help` 安全退出，`--no-open` 仍会启动服务。
- 测试使用临时合成世界/数据库，不修改用户真实存档或备份。真实副本基准仅按任务授权执行。
- 按改动选检查；文档改动只核对内容和路径。业务变更补相关逻辑测试，检查通过后停止无理由重复验证。
- 根目录执行（`python` 应指向上述系统解释器，否则使用其绝对路径）：
  - Ruff：`python -m ruff check --config code/pyproject.toml <改动的Python路径>`，格式检查使用 `ruff format --check` 同参数。
  - Python：`python -m pytest -c code/pyproject.toml _references/tests/<相关测试文件> -q`；全量显式指定 `_references/tests`，不无范围收集参考仓库。
  - Node：`node --test _references/tests/<相关测试文件>.cjs`。
  - 入口：`python start.py --help`；前端：在 `code/frontend` 执行 `npm.cmd run build`。
- 缺依赖才安装；Python 使用系统解释器 `-m pip install -e "./code[dev]"`，前端 `npm.cmd ci`。不对参考仓库/旧环境运行安装、格式化或测试。
- 不将历史测试数量当作当前验证，不把逻辑/构建通过描述成真实 UI、性能或游戏兼容性验收。

## 数据安全与行为基线

- 保留 NBT 类型、未知字段、根名称和无损 64 位整数（API 用字符串）；无效命令、批量操作先完整校验，不得部分修改。保留 revision、文档锁、来源授权和外部冲突检测。
- 保留 `level.dat` 的文件头、备份、校验和替换流程；数据库不建备份、不自动创建/修复/压缩，支持键经验证后单次同步 batch 保存。`level.dat` 与数据库不是跨存储事务，失败保留真实保存点和可重试状态。
- 单记录上限 16 MB；历史/保存点/批量快照共享 64 MB，记录历史最多 50 次。大批原始字节快照留内存且无损压缩，不绕过预算。
- 关闭时确认未保存内容及输入草稿；保存/校验失败保留窗口与修改。原生关闭回调不阻塞 UI 线程，保留前端失败时的原生确认兜底。
- 延迟读取数据库、记录及地图资源，取消过期请求；索引、预览和历史留内存。用户设置独立存于运行工作目录 `settings.json`，首次读取兼容迁移 `temp.json` 的旧 `preferences`；其他临时状态存 `temp.json`，保留其他命名空间。设置完整校验后原子替换，临时替换文件及时清理；测试用 `BEDROCK_EDITOR_STATE_DIR` 隔离两个文件。`app_constants.json` 仅维护内置常量和出厂默认值，不保存用户配置。
- 界面保持现有基岩版风格；不加冗余成功提示、状态说明或未经要求的面板。
- 最新地图画质默认 **4**，范围 0.01～100，值越大越早简化。显示类型默认普通地形+未生成；选取类型四类全开，两者独立。切回浏览/改变选取形状或类型清空选区，填充菜单保留选区。
- 地图简化仅用于显示；选取/删除使用完整真实目标，不截断或用代表样本代替。跨级缓存只复用相同维度/最高 Y/图层的真实样本，不扩散旧聚合像素。
- 区块删除、对象删除、维度重置的范围不同；涉及其实现前，按需读取交接档案对应章节和现有测试，保留同源兄弟数据、冲突检查及整批预检。
- 三维方块编辑、空心选区及含容器复制粘贴见 `voxels.py`、`voxel_clipboard.py` 和 README 开头；不恢复 262144 格/256 区块固定上限，继续按共享预算原子预检；规范状态来源见资源目录 `scene/block-states.README.md`。

## 按需导航

- 使用/安装：`code/README.md`，仅阅读相关章节。
- 模块职责、NBT/地图/关闭等详细约定、历史验证：`_references/docs/agent-handoff-2026-10-17.md`，按标题定位，历史冲突以本文件、最新用户确认及源码为准。
- 架构：`_references/docs/architecture-research.md`；地图对象：`_references/docs/map-object-layers.md`。
- 原版资源：`code/resource_packs/minecraft/README.md`；参考来源/许可证：`_references/README.md`。可直接复用第三方源码。
