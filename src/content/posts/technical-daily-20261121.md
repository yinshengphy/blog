---
title: "技术深潜｜2026年11月21日"
date: "2026-11-21"
description: "围绕JVM 原理与性能调优的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["JVM 原理与性能调优", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-11-21】  
【今日方向】：JVM 原理与性能调优

### 场景 + 问题

你负责一个 Java 17 的订单核心服务：8 核 CPU、32 GB 内存、堆上限 16 GB，使用 G1；单实例每秒约 2,000 次请求，P99 要求低于 200 ms。

发布新版本后出现：

- 平均延迟基本不变，但 P99 从 120 ms 升到 1.8 s；
- 每隔 2～5 分钟出现一次 500 ms～2 s 的延迟尖峰；
- GC 日志显示 Young GC 频繁，偶尔出现较长的 Mixed GC；
- Old Gen 占用持续上升，但 Full GC 并不频繁；
- CPU 使用率约 65%，没有明显 OOM；
- 业务代码近期新增了大 JSON 聚合、批量导出和本地缓存。

**问题：你会如何判断根因，并制定 JVM 调优方案？哪些参数不能盲目修改？**

### 一句话结论

先用 GC 日志、JFR、线程栈和分配速率确认“对象分配过快、晋升过多、Humongous 对象或并发标记跟不上”的具体原因，再针对性优化对象生命周期和堆布局；不要仅靠增大堆或强行调低 GC 停顿目标。

### 核心原理

G1 将堆划分为 Region，通过 Young GC、并发标记和 Mixed GC 回收年轻代及部分老年代。该故障通常有几类可能：

1. **分配速率过高**：大 JSON、中间集合、序列化缓冲区导致 Eden 很快耗尽，Young GC 变密。
2. **晋升压力过大**：缓存、批处理结果存活时间跨越多个 Young GC，进入 Old Gen，导致 Mixed GC 增多。
3. **Humongous 对象**：大于 Region 一半的连续数组、超大 byte[] 或 String，可能直接占用多个 Region，回收和碎片整理成本较高。
4. **并发标记跟不上分配**：Old Gen 增长速度超过 G1 标记回收速度，可能触发更保守的回收，甚至 Full GC。
5. **非 GC 原因**：Safepoint、锁竞争、JIT 编译、网络抖动或线程池排队，也可能造成相同的 P99 尖峰。

### 关键实现与工程取舍

先保留统一的可观测配置，避免只看 GC 次数：

```bash
java -Xms16g -Xmx16g \
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=200 \
  -Xlog:gc*,safepoint:file=/data/logs/gc.log:time,uptime,level,tags:filecount=10,filesize=100M \
  -XX:StartFlightRecording=filename=/data/jfr/app.jfr,duration=10m,settings=profile \
  -jar order-service.jar
```

排查顺序：

- 对比 GC 前后堆占用、Eden 分配速率、晋升速率、Old Gen 曲线；
- 查看 Humongous Region、Mixed GC 回收效率及是否出现 evacuation failure；
- 用 JFR 的 Allocation in New TLAB、Object Statistics、GC、Safepoint、Thread Park 定位热点；
- 用线程 dump 判断请求线程是否卡在锁、队列、同步 IO 或连接池；
- 将新版本与旧版本做分配速率和对象存活年龄对比。

优先级最高的修复通常是：

- 流式处理大 JSON/导出结果，避免一次构造完整 byte[]、List 或 String；
- 限制本地缓存容量和 TTL，避免把业务缓存直接变成老年代常驻对象；
- 复用合适的缓冲区，但避免无界池化导致内存滞留；
- 拆分批次，控制单次请求的峰值对象量；
- 检查大数组、压缩包、图片、报表等 Humongous 对象。

参数调优只能作为后手。可评估 `G1ReservePercent`、`InitiatingHeapOccupancyPercent` 和合理的堆大小，但不能为了降低 Young GC 频率而无限扩大 Eden，也不能只把 `MaxGCPauseMillis` 调得很小：目标越激进，G1 可能增加并发工作和 GC 频率，吞吐下降。

### 故障边界

- Old Gen 上升不一定是泄漏，必须看 Full GC 后是否回落；
- GC 时间高不一定是 GC 根因，可能是应用在 GC 期间同时发生锁等待或下游超时；
- 堆使用正常但 RSS 高，要继续检查 Metaspace、线程栈、DirectByteBuffer、JNI 和代码缓存；
- Full GC 少也不代表健康，长时间 Mixed GC、晋升失败或 Safepoint 停顿同样会打爆 P99；
- 不建议在生产环境直接切换收集器或大幅修改十余个 JVM 参数，应先灰度并保留回滚方案。

### 监控、排障与常见追问

核心监控：

- GC pause 分位数、Young/Mixed/Full GC 次数与耗时；
- Eden 分配速率、晋升速率、Old Gen 使用量及 GC 后基线；
- Humongous Region、Evacuation Failure、To-space Exhausted；
- Safepoint 总耗时及进入原因；
- JFR 分配热点、线程阻塞、JIT 编译；
- 进程 RSS、堆外内存、线程数、请求排队和下游耗时。

建议执行：

1. 先按时间对齐 P99、GC、Safepoint、CPU、线程池和下游指标；
2. 用 JFR 找出分配最多的调用栈，而不是直接猜某个类泄漏；
3. 对比 GC 前后对象存活集合，必要时做两次 Heap Dump 比较增长类型；
4. 通过压测复现大 JSON、批量导出和缓存命中场景；
5. 优先改代码和数据规模，再做小步参数灰度。

常见追问：

- **如何区分内存泄漏和正常缓存增长？**  
  看 Full GC 或多轮 Mixed GC 后的 Old Gen 基线；基线持续增长且由同一引用链持有，才更像泄漏。
- **为什么增大堆可能无效？**  
  它只能延长触顶时间，不能降低分配速率、对象存活率和单次大对象成本，甚至会增加标记和回收工作量。
- **什么时候考虑 ZGC？**  
  当业务更重视极低停顿、堆较大且吞吐可接受一定损失时评估；必须通过压测验证 CPU、吞吐、延迟和运维成熟度。
- **如何证明是 Safepoint 而不是 GC？**  
  对照 `safepoint` 日志和 JFR；若停顿时间明显高于 GC pause，且原因是反优化、清理或其他 VM 操作，应分开处理。

### AI 应用层 GitHub 项目

**RAGFlow**  
GitHub：<https://github.com/infiniflow/ragflow>  
简介：RAGFlow is an agent-native database: a Retrieval-Augmented Generation (RAG) engine that grew into context infrastructure.  
语言：Go；Stars：94,486；最近更新：2026-11-20。
