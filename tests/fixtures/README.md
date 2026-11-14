# WorkBuddy 查看状态夹具

2026-11-03 在临时目录用本机已有 ClassicLevel 生成的原生 LevelDB 文件，全部 ID 与内容为合成数据，不含用户记录。该库只用于生成 / 核对，不是项目运行或测试依赖。

- `workbuddy-view-state`：Snappy 表中有旧已读 / 未读数组和其他 origin；较新 WAL 写入 UTF-16 已读数组，并将一条未读变成已读。
- `workbuddy-view-deleted`：继续写入已读 key 的删除记录和空未读数组，验证不得复活旧表值。
- `workbuddy-view-fragmented`：再写入 1500 个合成已读 ID，跨越 WAL 的 32 KB 分块。

每组保留 CURRENT、MANIFEST、活跃表和 WAL，不含 LOCK 或业务内容。测试只读文件，不用 LevelDB 打开这些目录。
