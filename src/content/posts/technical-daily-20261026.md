---
title: "技术深潜｜2026年10月26日"
date: "2026-10-26"
description: "围绕AI 工程与大模型应用开发的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["AI 工程与大模型应用开发", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-10-26】
【今日方向】：AI 工程与大模型应用开发

### 场景与故障现象
**生产场景**：
某企业级智能知识助手后端（基于 Java 21 / Spring Boot 3.3 + Reactor Netty 构建），对外提供 SSE（Server-Sent Events）流式问答接口。链路包含：客户端发起会话 $\to$ 混合检索（向量 + BM25）$\to$ 交叉重排（Reranker）$\to$ 上下文组装 $\to$ 调用自建 vLLM 推理网关流式吐出 Token $\to$ Netty 封装 SSE 推流到客户端浏览器/移动端。

**约束条件**：
- 单实例需稳定维持 2,500+ SSE 长连接并发；
- 弱网与移动端用户占比超过 30%，存在高频主动关闭标签页、锁屏、断网重连等情况；
- 依赖上游 vLLM 推理节点计费与算力卡点严格（单卡并发受限，无效推理必须立刻终止）。

**故障现象**：
高峰期大量移动端用户报告“流式问答卡死在第 1~3 个字”、“首字延迟（TTFT）从平时的 800ms 恶化至 18s+”。同时系统频繁告警：
1. 后端 JVM 的 Netty `DirectMemory`（堆外内存）持续线性增长并逼近上限，频发 `OutOfDirectMemoryError`；
2. 观察推理网关监控发现，前端用户明明已经关闭页面或取消生成，底层 vLLM 的 PagedAttention 显存却依然被占满，GPU 持续全负荷生成完整长文本（1000+ Tokens），无效并发将有效请求挤入排队队列，导致整体 TTFT 严重劣化。

---

### 一句话结论
流式 AI 接入层的核心矛盾是**“推理端高频 Token 生产与弱网客户端低速/断线消费的速度失配”**。必须在 Reactive 传输层配置动态高低水位背压（High/Low Watermark），并建立**双向连接感知与取消传播机制（Cancellation Propagation）**，确保客户端断连时向 LLM 推理端级联发送终止信号，阻断无效算力消耗与堆外 Buffer 堆积。

---

### 核心原理
1. **反向背压失效与堆外堆积**：
   - LLM 推理以 Chunk 形式（每秒 30~80 tokens）高速推流，如果下游移动端处于弱网（TCP 拥塞窗口收缩，`rcv_buf` 满），Netty 的 SocketChannel 不可写（`channel.isWritable() == false`）。
   - 若响应式流（Reactive Streams）未正确限制 `request(n)` 或未配置 Netty 写入背压，Netty 会将未发送的 Chunk 缓存在 `ChannelOutboundBuffer`（堆外内存）。数千个会话堆积数秒即可击穿堆外内存。
2. **连接孤儿与算力击穿（Zombie Inference）**：
   - 客户端单方面断开（如直接划掉 App 或关闭浏览器）时，操作系统首先触发 TCP FIN/RST。
   - 如果服务端采用传统的阻塞转发或仅在业务逻辑外层做超时，底层未绑定 `doOnCancel` / `Sink.asFlux()` 的生命周期，下层针对 LLM Client 的 HTTP/2 请求（或 gRPC 流）不会主动调用 `cancel()` 或发送 `RST_STREAM`。LLM 网关继续进行 Self-Attention 迭代解码，耗尽 PagedAttention 显存池，引发排队雪崩。

---

### 关键实现（Spring WebFlux + Reactor Netty + SSE）

```java
@RestController
@RequestMapping("/api/v1/chat")
public class ReactiveRAGChatController {

    private final LLMStreamingClient llmClient;
    private final HybridRetrievalService retrievalService;

    public ReactiveRAGChatController(LLMStreamingClient llmClient, HybridRetrievalService retrievalService) {
        this.llmClient = llmClient;
        this.retrievalService = retrievalService;
    }

    @PostMapping(value = "/completions", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> streamChat(@RequestBody ChatRequest request) {
        AtomicBoolean isDownstreamClosed = new AtomicBoolean(false);

        return Mono.fromCompletionStage(() -> retrievalService.retrieveContextAsync(request.query()))
            .flatMapMany(context -> {
                Prompt prompt = PromptBuilder.build(request.query(), context);
                // 1. 发起大模型推理流
                return llmClient.streamChat(prompt);
            })
            // 2. 核心：双向生命周期感知与取消传播
            .doOnCancel(() -> {
                isDownstreamClosed.set(true);
                // 级联中断上游：发送 HTTP/2 RST_STREAM 或调用 vLLM 取消接口
                llmClient.abortGeneration(request.sessionId());
            })
            // 3. 反应式背压防护与限流：防止下游消费慢导致堆外无序积压
            .onBackpressureBuffer(
                64, // 仅允许有限缓冲区
                droppedChunk -> log.warn("Session {} buffer full, dropping chunk", request.sessionId()),
                BufferOverflowStrategy.DROP_OLDEST
            )
            // 4. 封装 SSE 并增加客户端 Keep-Alive 探针，避免反向代理透明超时断开
            .map(token -> ServerSentEvent.<String>builder()
                .event("message")
                .data(token)
                .build())
            .timeout(Duration.ofSeconds(60))
            .onErrorResume(e -> {
                if (isDownstreamClosed.get()) {
```

```java
                    return Flux.empty(); // 客户端主动断开，静默终结
                }
                return Flux.just(ServerSentEvent.<String>builder()
                    .event("error")
                    .data("Generation interrupted: " + e.getMessage())
                    .build());
            });
    }
}
```

**Netty 接入层关键网络参数配置（application.yml）**：

```yaml
server:
  netty:
    # 调低 Socket 发送水位线，避免单连接堆外内存驻留过大
    write-buffer-high-water-mark: 64KB
    write-buffer-low-water-mark: 16KB
    idle-timeout: 45s
```

### 工程取舍
| 方案 | 优点 | 缺点 / 权衡代价 |
| :--- | :--- | :--- |
| **DROP_OLDEST 策略背压** | 极度保护服务器堆外内存，永远不会引发 `OutOfDirectMemoryError`。 | 极慢网络用户可能丢失中间部分 Token 碎块，导致客户端渲染跳字。 |
| **动态暂停拉取（Reactive Pull）** | 严格保证 Token 顺序完整性，不丢字。 | 占满 LLM 网关的流式缓冲，需要推理引擎本身支持对单请求暂停推流（目前多数 LLM 推理引擎仅支持 continue 或 abort，不支持单步 pause）。 |
| **断连立即终止（Abort-on-Disconnect）** | 最大化释放推理卡算力，消除无效显存占用。 | 若用户因 4G/5G 瞬时切换发生断连，恢复后无法断点续接，必须重新检索并重算 Prefill。 |

---

### 故障边界与防御机制
1. **反向代理（Nginx / ALB）缓冲击穿**：
   - 若前置 Nginx 开启了 `proxy_buffering on;`，SSE 响应会被 Nginx 缓存，直到填满 buffer 才会一次性刷给前端，导致 TTFT 表象极大，且 Nginx 断开不能即时传导给 Java 进程。必须针对 SSE 路由显式声明 `X-Accel-Buffering: no` 与 `proxy_ignore_client_abort on`（让后端捕获断连）。
2. **Context Prefill 阶段无法中断**：
   - 如果客户端在 RAG 检索完成、大模型 Prefill（首字计算耗时段）阶段断开，HTTP/1.1 连接往往无法及时中断底层的计算阻塞。必须升级上游通信协议至 HTTP/2 或 gRPC，确保客户端发送 CANCEL 帧能直通 vLLM 的 Request Tracker 并将请求从 Scheduler 队列摘除。
3. **心跳保活与幽灵连接**：
   - 移动端切后台后网络可能静默挂起。必须每隔 15 秒下发注释帧（`ServerSentEvent.builder().comment("keepalive").build()`）。若 TCP 探针判定心跳连续 2 次无 ACK，立刻主动调用 `channel.close()` 释放堆外缓冲与并发槽位。

---

### 监控排障矩阵
- **核心指标 1：TTFT（Time To First Token）与 TPOT（Time Per Output Token）分位线**（P95/P99）。若 TTFT 飙升而 TPOT 稳定，排查排队队列与 Prefill 算力；若两者同步恶化，排查网络背压与 Netty 线程池阻塞。
- **核心指标 2：`jvm.netty.direct.memory.used` 与 `netty.channel.outbound.buffer.bytes`**。监控堆外未写出字节数，一旦出现倾斜直接定位到对应 Session 对应的 Socket。
- **核心指标 3：Abort / Request 比例（算力浪费率）**。统计 LLM 端由 `Client Cancel` 触发的中断量，健康值通常在 3%~8%；超过 15% 说明前端存在交互缺陷或网络超时配置不合理。

---

### 常见追问
1. **Q：如果前端断线后又需要“断点续生成”，架构上如何支持？**
   - **A**：不能直接把 LLM 的流与单个长连接死绑定。需在中间引入 Redis Streams 或 RingBuffer 机制：LLM 生成内容解耦推入缓存，后端仅充当消费端并维护游标（Sequence ID）；客户端重连带上 `Last-Event-ID`，先从缓存回放未送达数据，未生成完的部分继续桥接流。
2. **Q：Java 21 虚拟线程（Virtual Threads）能直接替代 Reactor Netty 解决上述流式背压问题吗？**
   - **A**：不能。虚拟线程极大简化了并发编程模型并提升了吞吐，但**虚拟线程底层仍然依赖标准的阻塞 I/O**。在“慢速消费端”场景下，虚拟线程会在 `Socket.write()` 上持续阻塞挂起，若没有像 Reactive Streams 严格规范的响应式请求量控制与内存水位配置，依然会导致堆内/堆外对象的大量暂留，造成隐蔽的内存膨胀。

---

### AI 工程推荐项目
**The-Vibe-Company/quivr**
- **URL**：https://github.com/The-Vibe-Company/quivr
- **Stars**：39,603 | **Language**：Go | **Updated**：2026-10-25
- **定位与价值**：面向非结构化内容流的高性能摄取、混合检索（Hybrid Search）、监控与警报开源引擎。在构建流式 RAG 体系时，其高效的多模态数据持久化处理与可插拔的模型规则架构，为解耦摄取流与检索推理流提供了极具工程参考价值的设计范式。
