---
title: "技术深潜｜2026年11月17日"
date: "2026-11-17"
description: "围绕Linux、DevOps 与 Kubernetes的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["Linux、DevOps 与 Kubernetes", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-11-17】
【今日方向】：Linux、DevOps 与 Kubernetes

**题目：**  
某电商结算服务运行在 Kubernetes，3 个可用区、节点使用 cgroup v2，Deployment 配置了 HPA、PDB 和滚动发布。一次版本发布后，流量仅增加 20%，但出现 P99 从 300ms 升到 4s、5xx 达 3%、Pod 间歇性 `OOMKilled`、部分 Pod readiness 抖动；节点 CPU 平均 55%、内存平均 68%，监控却显示少量节点 `memory.pressure` 和 TCP 重传升高。约束是不能立即扩容节点、不能停止发布流水线、不能牺牲多可用区容灾。请说明你的定位顺序、根因判断、修复方案和长期治理措施。

**一句话结论：**  
不能用“节点平均资源充足”判断系统健康，应沿请求链路从发布差异、Pod cgroup、Linux PSI/TCP、依赖队列到 HPA 信号逐层定位，并优先修复资源隔离、探针和发布策略。

**核心原理：**

1. **调度资源不等于运行时资源**  
   Kubernetes 依据 `requests` 调度，容器实际消耗由进程、cgroup limit、内核回收和节点竞争共同决定；节点平均值会掩盖单节点、单 Pod 和 NUMA/磁盘局部热点。

2. **OOM 与 CPU 限流都可能表现为延迟**  
   cgroup v2 中应同时观察 `memory.current`、`memory.events`、`memory.pressure` 和 `cpu.stat`。  
   - `oom_kill` 增加：可能是容器达到 limit，也可能是节点内存压力下被回收。  
   - `nr_throttled`、`throttled_usec` 增加：CPU limit 导致请求排队。  
   - PSI 升高：说明任务因资源争用实际“无事可做地等待”。

3. **探针失败会放大故障**  
   readiness 失败会摘流量，liveness 失败会重启；如果探针与业务共用线程池、数据库连接池或下游依赖，依赖抖动可能触发级联重启。

4. **HPA 只看 CPU 不够**  
   该服务可能受数据库连接池、线程池、锁竞争、网络重传或队列长度限制。CPU 55% 并不能证明没有容量问题。

**关键实现：**

```yaml
resources:
  requests:
    cpu: "500m"
    memory: "1Gi"
  limits:
    cpu: "2"
    memory: "2Gi"
startupProbe:
  httpGet: {path: /startup, port: 8080}
  failureThreshold: 30
  periodSeconds: 5
readinessProbe:
  httpGet: {path: /ready, port: 8080}
  timeoutSeconds: 2
  periodSeconds: 5
  failureThreshold: 3
livenessProbe:
  httpGet: {path: /live, port: 8080}
  periodSeconds: 10
  failureThreshold: 6
terminationGracePeriodSeconds: 60
```

发布时采用小批量 canary，按错误率、P99、OOM、重启次数和业务成功率自动暂停；`maxUnavailable` 控制在可承受范围，并确保跨可用区拓扑分布。`preStop` 先摘流量，再等待连接排空，避免滚动发布制造瞬时连接风暴。

**工程取舍：**

- 不应直接把所有内存 limit 调大：这可能掩盖泄漏，并把 OOM 从容器级推迟为节点级故障。应先比较堆、堆外内存、线程栈、缓存和连接池；Java 服务还要核对容器感知参数与 GC 日志。
- CPU limit 有利于隔离，但过紧会产生 throttling；延迟敏感服务可评估提高 limit、降低单 Pod 并发，或使用更合理的 CPU requests。不能只看利用率。
- PDB 保护可用性，但过严会阻塞节点维护和发布；应结合副本数、跨区分布和故障预算设置。
- HPA 增加并发数、队列长度或请求时延等自定义指标，但指标必须经过降噪、限幅，避免下游故障时无限扩容造成雪崩。
- 对连接池、线程池、重试和超时设置预算：重试次数有限、带退避和抖动；超时必须小于上游整体超时，避免请求堆积。

**故障边界：**

- 若仅一个 Pod 的 `memory.events` 增长，优先查版本差异、缓存增长、堆外内存和流量倾斜。
- 若多个 Pod 同时出现 PSI、TCP 重传和延迟，查节点内核、网卡、conntrack、CNI、磁盘和宿主机邻居，而不是只改 Deployment。
- 若 Pod 正常但业务失败，查数据库、消息队列、DNS、TLS、连接池和下游限流。
- 若只有发布期间恶化，重点查 readiness 提前放量、旧 Pod过早终止、连接排空和 canary 流量切分。
- 若所有节点同时异常，优先排查共享依赖、配置、证书、服务发现和发布变更。

**监控与排障顺序：**

1. 先按时间线对齐发布、流量、错误、P99、重启和 HPA 扩缩容事件。  
2. 按 Pod/节点/可用区切分，查看 `kubectl describe pod`、事件、容器退出码和上次日志。  
3. 在节点与容器内核指标中核对 PSI、cgroup memory/cpu、磁盘 IO、TCP retransmit、socket 使用量和 conntrack。  
4. 对比应用线程池、GC、连接池、队列长度、下游耗时及 trace span。  
5. 先暂停扩散、降低 canary 流量或回滚；确认根因后再调整资源和 HPA，避免“盲目扩容”。

**常见追问：**

- 为什么节点内存 68% 仍会 OOM？答：局部 cgroup limit、突发分配、内核回收、不可回收内存或单节点压力都可能触发。  
- 如何区分 CPU 不够与 CPU throttling？答：同时看业务 CPU、`cpu.stat` 的 throttled 指标、运行队列和 P99，不能只看 `top`。  
- liveness 为什么不能检查数据库？答：下游故障不应导致所有 Pod 重启，应让 readiness 摘流量，并由依赖超时与熔断保护。  
- 如何证明修复有效？答：用相同流量和发布节奏做 canary，对比成功率、P99/P999、OOM、throttling、PSI、重传和下游饱和度。

**AI 应用层 GitHub 项目推荐：**  
[crewAIInc/crewAI](https://github.com/crewAIInc/crewAI)：用于编排具有角色分工的自主 AI Agent、促进协作完成复杂任务的 Python 框架；**60,994 Stars**。
