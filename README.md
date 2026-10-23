# Bedrock Studio

面向 Minecraft 基岩版的本地世界编辑器，提供 NBT 数据编辑、二维区块地图和三维方块编辑。当前版本为 **1.0.0 Beta**，主要面向 Windows 桌面环境。

项目采用 Python、FastAPI、React、TypeScript、Three.js 和 pywebview。

## 功能

- **存档工作台**：发现本机基岩版存档，也可手动选择世界文件夹；支持最近打开、排序和封面视图。
- **NBT 编辑**：查看和编辑 `level.dat`、玩家及受支持的世界数据库记录，支持标签搜索、新增、修改、删除、批量操作与撤销/重做。
- **二维地图**：浏览区块地形与高度，按类型选择区块，新增空区块、删除区块或清空所选区块的方块；可显示玩家、实体、方块实体、村庄等信息图层。
- **三维编辑**：浏览方块场景，选择和修改方块，复制、移动、粘贴选区，以及处理包含容器的方块数据。
- **结构与对象**：提供结构文件导入/导出和受支持地图对象的 NBT 编辑，具体格式与操作边界见[详细说明](code/README.md)。
- **个性设置**：调整快捷键、默认视图、视距、飞行速度和动画偏好。

## 从源码运行

准备 Windows x64、Python 3.12（建议 3.12.10）、Node.js 20.19+ 和 Microsoft Edge WebView2 Runtime。以下命令使用系统 Python，不需要创建虚拟环境。

```powershell
git clone https://github.com/tingting-bro/BedrockStudio.git
cd BedrockStudio
python -m pip install -e "./code[dev]"
cd code/frontend
npm.cmd ci
npm.cmd run build
cd ../..
python start.py
```

默认打开桌面窗口。也可以使用浏览器模式：

```powershell
python start.py --browser
```

查看启动参数（不会启动服务或窗口）：

```powershell
python start.py --help
```

数据库访问需要 Node.js 及通过 `npm.cmd ci` 安装的原生数据库驱动。三维场景首次使用时需要联网下载资源，后续复用本地缓存；下载渠道与渲染限制见[详细说明](code/README.md)。

## 基本使用与存档安全

1. 退出正在使用该世界的 Minecraft，并自行备份完整世界文件夹。
2. 启动程序，选择自动发现的存档，或通过「其他存档」选择包含 `level.dat` 的文件夹。
3. 进入 NBT 数据模式或世界区块模式，完成编辑并检查操作范围。
4. 使用保存按钮或 `Ctrl+S` 写入修改。关闭时如有未保存内容，按提示选择保存、放弃或取消。

`level.dat` 保存会生成文件备份；数据库保存使用同步批次，**不会自动备份整个数据库**。两者不是跨存储事务。部分地图删除或维度重置操作在保存后无法通过地图界面恢复，请以各操作的确认提示为准。

程序会检查数据库占用和外部修改；不自动创建、修复或压缩数据库。不保证所有游戏版本、加密存档或第三方扩展格式都能编辑，Beta 阶段建议先使用存档副本。

## 构建 Windows 安装包

构建环境还需要 Inno Setup 6 和受 Nuitka 支持的 C 编译工具。项目根目录执行：

```powershell
python -m pip install -e "./code[build]"
python build.py --check
python build.py
```

产物位于 `build/`。安装包携带 Python、Node.js 和必要运行依赖，目标电脑无需另外安装 Python 或 Node.js，但仍需要 WebView2 Runtime 和 .NET Framework 4.7.2+。构建包含隐藏窗口冒烟验证，需要可用的 Windows 桌面环境。更多参数见[编译与安装包说明](code/README.md#编译与安装包)。

## 一键提交上传

本地工作区中的 `updeta.py` 为个人上传辅助脚本，不随仓库发布；已有该脚本时，在项目根目录运行：

```powershell
python updeta.py
```

按提示输入本次上传的**提交信息**，例如「修复区块选择并更新说明」。脚本会先检查当前分支与远端更新，再暂存遵循 `.gitignore` 的全部修改（包括新增、修改和删除）、创建提交并推送到本仓库的同名分支。没有文件修改时仍可重试上传已有提交。可从其他工作目录通过脚本的完整路径运行。

需要已安装 Git、已配置提交身份，并有目标仓库写入权限。遇到登录、网络、冲突或远端更新等问题时会停止并输出解决方法；不会自动合并、强制推送或回滚。推送失败后本地提交会保留，解决问题后再次运行即可。`python updeta.py --help` 仅显示帮助，不提交或上传。

## 项目结构

```text
BedrockStudio/
├─ start.py                       # 启动入口
├─ build.py                       # Windows 打包入口
├─ code/
│  ├─ backend/src/bedrock_editor/  # FastAPI、存档处理与桌面集成
│  ├─ frontend/                   # React / TypeScript / Three.js
│  ├─ resource_packs/             # 图标、字体和静态资源
│  ├─ tools/                      # 资源准备工具
│  ├─ pyproject.toml              # Python 依赖与工具配置
│  └─ README.md                   # 详细功能与操作说明
└─ LICENSE
```

运行时在工作目录保存 `settings.json`（用户设置）、`temp.json`（最近记录等状态）和 `data/render-resources/`（下载资源缓存）。这些内容、依赖目录、构建产物、本地上传脚本 `updeta.py` 以及整个 `_references/` 目录不提交到仓库。源码仓库不包含已编译安装包。

## 许可证与第三方资源

项目自有代码采用 [MIT License](LICENSE)。第三方代码、字体和 Minecraft 素材保留各自的许可与版权，不因本项目许可证而改变：

- Minecraft 原版素材来自 Mojang，受其版权和 Minecraft EULA 约束，见[素材说明](code/resource_packs/minecraft/README.md)及[许可文件](code/resource_packs/minecraft/LICENSE.md)。
- 字体许可见 [OFL.txt](code/resource_packs/fonts/OFL.txt)。
- 随附结构处理代码和方块数据的许可分别见 [mcstructure_LICENSE.txt](code/backend/src/bedrock_editor/mcstructure_LICENSE.txt) 与 [BedrockData-LICENSE.txt](code/resource_packs/minecraft/scene/BedrockData-LICENSE.txt)。

本项目为非官方工具，与 Mojang 或 Microsoft 无隶属关系。
