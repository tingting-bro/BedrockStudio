# 本地 Minecraft 原版图标

图标来源为 Mojang 官方 [bedrock-samples](https://github.com/Mojang/bedrock-samples)，固定提交 `46ba6ea985fb5a92d79a9419198f10dda14c199d`。

`vanilla/` 保存该提交的完整原版资源包，`icons/` 保存生成的 32×32 PNG。当前支持 3580 个资源名称；生成工具读取 item_texture / terrain_texture 的纹理索引和变体、blocks.json 的方块定义、可用的物品 identifier/icon 定义及生物 identifier/texture/geometry 定义，生成前端的 minecraft-textures.json。运行时按对象名称自动匹配，兼容 minecraft: 前缀、大小写和常见旧版别名，不把其他命名空间当作原版对象。

玩家取史蒂夫面部；生物按原版模型 UV 投影头部正面；箱子、方块和物品使用对应纹理。缩放采用最近邻并保留透明背景。绵羊的 alpha 是游戏着色遮罩，生成图标时转换为不透明颜色。此资源包用于离线图标，地图地表仍使用原有颜色渲染。

`manifest.json` 记录每张图片的源 URL、原始资源和产物 SHA-256、所用模型来源。版权和适用条款见原仓库的 `LICENSE.md`：Mojang AB 保留所有权利，资源受 Minecraft EULA 约束。

图标只读取这些本地文件，不请求网络。需要重新生成时，用系统 Python 执行 `code/tools/prepare_minecraft_icons.py`；默认下载固定提交归档到 `_references/`，可用 `--archive` 指定已经下载的归档，随后完整离线重建。不支持的生物模型及缺失纹理列在 manifest 的 unmapped 中；没有对应纹理的对象使用通用分类图标，未知分类保留符号。Pillow 现为 3D 原版资源的运行依赖。

Vite 构建将上述资源复制到 dist/minecraft，桌面 FastAPI 对应挂载 /minecraft；字体同样通过 /fonts 开放。资源访问回归测试覆盖全部生成图标的 HTTP 状态、类型、原始字节及目录越界保护。

3D 经典画质路径读取 `level.dat` 的 `lastOpenedWithVersion`，从 Mojang 官方 bedrock-samples 优先下载匹配前三位版本的正式发布资源；缺失时自动选择最近的正式版，优先同一主/次版本系列，距离相同选较旧版，不选择 preview。资源保存在 `运行工作目录/data/render-resources/bedrock/<实际资源版本>/`，同版本及已解析的回退版本均直接复用本地缓存，旧 amulet 目录中的完整包会自动复制迁移，元数据和 API 保留实际资源版本。常见无状态完整方块、水、岩浆、海草和海带使用自写几何，液面跨存储层和区块连续计算，完整方块使用顶点 AO。其他模型仍通过 PyMCTranslate 翻译状态、Amulet `minecraft-resource-pack 1.4.11` 解析 Java 模型，Java 原版资源保存在 `运行工作目录/data/render-resources/<Java版本>/`。图集、模型索引和缓存留内存，通过带会话校验的 API 提供，场景与粘贴预览共用。动画目前使用首帧，尚未达到原版画面完全一致；版本选择和能力边界见 `../../../_references/docs/classic-rendering.md`。原版素材继续适用 Mojang 版权及 EULA，Amulet 组件保留各自许可。

原 `scene/atlas.png` 和 `scene/atlas.json` 保留供旧网格逻辑测试；`code/tools/prepare_scene_atlas.py` 仍可从 `vanilla/` 离线重建，但不再作为默认 3D 场景资源入口。接入细节及能力边界见 `../../../_references/docs/amulet-rendering-reuse-2026-10-18.md`。

`scene/entity-models.json` 由 `code/tools/prepare_entity_models.py` 从已有 `vanilla/entity` 和 `vanilla/models` 离线建立索引：优先使用无版本后缀的原版定义，展开旧版继承几何，转换 TGA 贴图并处理羊毛透明遮罩；运行时按需读取本地原版贴图。实体使用静态骨骼/方块几何、正确的旋转中心和 UV，并选择幼年/剪毛模型。离线工具仅提取无条件 setup 中可确定的静态平移、旋转、缩放及幼年缩放，不执行动态 Molang、动画或自定义渲染控制器；无可用模型的实体保留可选占位模型。此索引及所引用素材适用本目录的 Mojang 版权及 EULA。
