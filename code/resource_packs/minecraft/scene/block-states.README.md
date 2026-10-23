# 基岩版方块基础状态

`code/backend/src/bedrock_editor/block_states.json` 从 pmmp/BedrockData 的固定版本 `bedrock-1.21.80` 的规范方块调色板提取，每种方块保留第一个有效状态及原始 Byte/Int/String 类型、版本号；这是确定的有效基础状态，不模拟游戏放置方向或邻接更新。

- 源：https://github.com/pmmp/BedrockData/tree/bedrock-1.21.80
- 原始文件：https://raw.githubusercontent.com/pmmp/BedrockData/bedrock-1.21.80/canonical_block_states.nbt
- 源文件 SHA-256：`844b211112d29cb013cc74d4fd0241d59d3757b7efccdb299348fc65d75a3fa1`
- 数据许可：CC0 1.0，完整许可见同目录 `BedrockData-LICENSE.txt`。
- 本地原始数据：`_references/bedrock-1.21.80-canonical-block-states.nbt`。

在项目根目录离线重建：

```powershell
& 'E:\Python\Python312\python.exe' code/tools/prepare_block_states.py _references/bedrock-1.21.80-canonical-block-states.nbt code/backend/src/bedrock_editor/block_states.json
```

编辑已有同类方块优先复用实际调色板状态；未发现时使用此基础状态。该版本以外的新方块如无可靠状态，仍需复制已有实例，不能用空 Compound 猜测状态。涉及方块实体、门床等配对或事件的方块仍保留直接填充限制；复制粘贴可保留已有状态与方块实体。生物及其他独立实体不复制。
