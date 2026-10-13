---
title: "技术深潜｜2026年10月14日"
date: "2026-10-14"
description: "围绕AI 工程与大模型应用开发的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["AI 工程与大模型应用开发", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-10-14】
【今日方向】：AI 工程与大模型应用开发

### 生产场景与故障描述
在某金融券商的企业级投研智能 Agent 平台中，后端基于 Java 21 + Spring AI / LangChain4j 构建，提供基于 Server-Sent Events (SSE) 的长上下文流式问答与多工具链（Function Calling）调用。
在早盘交易高峰期，上游大模型提供商（API）发生偶发性推理排队，首字延迟（TTFT）从 800ms 飙升至 6s+，单次推理总时长拉长至 40s。
**故障现象**：
1. 客户端大量用户因等待超时主动关闭网页或刷新重试，但网关与 Java 后端未及时终止底层与大模型的 HTTP 持续流式连接；
2. 后端继续接收大模型生成的多轮 Tool Calls，盲目触发本地/远程行情数据库的高频慢查询工具执行；
3. 大量“幽灵生成（Ghost Generation）”吞噬了企业的 LLM 租户 TPM/RPM 配额，导致正常请求全线报 `429 Too Many Requests`；
4. 随着并发堆积，Netty 堆外内存与响应式线程队列急剧膨胀，最终导致应用节点 OOM 崩溃并产生级联雪崩。

---

### 一句话结论
**LLM 流式应用必须构建双向闭环的协同取消与背压机制**：通过响应式信号链路将客户端 SSE 断开事件严格传递至 LLM Client 取消底层 HTTP 连接，配合工具链前置上下文校验与租户级并发/Token 熔断漏斗，从根源掐断孤儿任务与无效 Token 消耗。

---

### 核心原理
1. **客户端断连感知的传播断层**：
   在 Spring WebFlux / SSE 架构中，客户端断开连接会触发下游 Sink 的取消信号（Cancel Signal）。若底层调用 LLM 的 HTTP 客户端（如 Reactor Netty、JDK HttpClient）未与该 Reactive Stream 的 Cancellation 绑定，底层 HTTP 长连接将继续拉取流，导致 Stream 不会关闭，大模型持续消耗 Output Token。
2. **工具调用（Function Calling）异步悬挂**：
   LLM 在流式输出中吐出 `tool_calls` 片段后，Agent 编排框架通常会反射调用具体的 Java 方法。如果该方法缺乏不可变上下文超时（Context Propagation & Cancellation），即使流已废弃，昂贵的 I/O 工具函数依然会执行完毕，造成严重的线程与资源泄漏。
3. **推拉背压失衡（Mismatch Backpressure）**：
   LLM 以不定速率推送 chunk，若客户端消费速率极慢（弱网环境），若服务层缓存策略配置不当，会在堆内或 Netty 缓冲区中堆积大量未消费的 Chunk 对象，引发内存暴涨。

---

### 关键实现（基于 Project Reactor 与虚拟线程模型）

```java
@RestController
@RequestMapping("/api/v1/agent")
public class AgentStreamingController {

    private final ChatModel chatModel;
    private final ToolExecutionService toolService;

    public AgentStreamingController(ChatModel chatModel, ToolExecutionService toolService) {
        this.chatModel = chatModel;
        this.toolService = toolService;
    }

    @PostMapping(value = "/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> chatStream(@RequestBody PromptRequest request) {
        AtomicBoolean isAborted = new AtomicBoolean(false);

        return chatModel.stream(request.toPrompt())
            // 1. 客户端主动断开或下游取消时，强制向底层发送取消信号并记录标志位
            .doOnCancel(() -> {
                isAborted.set(true);
                // 触发底层 HTTP 连接中止与计量结算
                Metrics.counter("llm.stream.client.cancelled").increment();
            })
            // 2. 拦截 Function Call 执行阶段：在执行耗时工具前做前置熔断校验
            .concatMap(chunk -> {
                if (isAborted.get()) {
                    return Flux.empty(); // 截断后续处理
                }
                if (chunk.hasToolCall()) {
                    return executeToolWithContext(chunk.getToolCall(), isAborted);
                }
                return Flux.just(chunk);
            })
            .map(chunk -> ServerSentEvent.<String>builder()
                .event("message")
                .data(chunk.getContent())
                .build())
            // 3. 背压保护：下游消费不及时的丢弃策略
            .onBackpressureBuffer(64, BufferOverflowStrategy.DROP_OLDEST)
            .timeout(Duration.ofSeconds(45))
            .onErrorResume(TimeoutException.class, e -> 
                Flux.just(ServerSentEvent.<String>builder().event("error").data("Generation Timeout").build())
            );
    }

```

```java
    private Flux<ChatChunk> executeToolWithContext(ToolCall toolCall, AtomicBoolean isAborted) {
        return Mono.fromCallable(() -> {
            // 工具执行前检查
            if (isAborted.get()) {
                throw new CancellationException("Pipeline cancelled before tool execution");
            }
            return toolService.invoke(toolCall);
        })
        .subscribeOn(Schedulers.boundedElastic()) // 隔离阻塞 I/O
        .flatMapMany(toolResult -> chatModel.stream(toolResult.toPrompt()));
    }
}
```

### 工程取舍与权衡

| 决策点 | 激进策略（快速丢弃） | 保守策略（缓冲等待） | 生产推荐方案 |
| :--- | :--- | :--- | :--- |
| **断连处理 (On Disconnect)** | 立即抛出异常并 Close TCP | 允许后台继续生成并缓存结果以便断点续传 | **立即 Close**：通用交互场景避免计费浪费；仅对长思考（Reasoning）离线任务转异步 Job |
| **Backpressure 策略** | `DROP_OLDEST` (丢弃最旧 Chunk) | `ERROR` (直接熔断报错) | **限长 Buffer + 客户端拉取心跳**：避免断句错乱引发前端 Markdown 语法解析崩溃 |
| **并发隔离** | 平台线程池固定上限 | 纯虚拟线程（Virtual Thread） | **信号量限流 + 虚拟线程**：虚拟线程防挂起，但必须加 Semaphore 限制并发调用 LLM 数量，防 API 配额穿透 |

---

### 故障边界与防御机制

1. **上游配额雪崩隔离**：
   * 建立前置的**滑动窗口 Token 预算桶（Budget Bucket）**。在请求进入 Agent 前估算 Prompt Token，预扣除配额；流式返回时按实际 `usage` 多退少补。
   * 配置独立 Circuit Breaker：当 LLM 提供商连续发生 5 次 5xx 错误或 TTFT > 10s 时，自动降级至备用模型（如从 OpenAI 降级至本地私有化部署的 DeepSeek/Qwen 实例）。
2. **工具执行防御（Function Calling Boundary）**：
   * 工具调用必须声明超时阈值（如单个工具限制 2s），严禁无界阻塞。
   * 将只读查询与写操作（如发帖、调仓）严格分离：对具有副作用的工具调用，必须引入**幂等 Token** 或“二阶段确认（Human-in-the-loop）”，严防并发重试导致重复下单。

---

### 监控指标与排障 SOP

1. **核心可观测指标**：
   * `llm.ttft.latency`：首字输出时间（P95/P99 突增往往预示提供商节点排队）。
   * `llm.tokens.wasted`：因用户 Cancel/Timeout 导致的废弃 Token 总量。
   * `http.server.requests.active{uri="/stream"}` vs `llm.client.connections.active`：若前者远小于后者，必定存在底层连接泄漏。
2. **紧急排障 SOP**：
   * **Step 1**：观察 API 网关的 HTTP 499 状态码（Client Closed Request）占比，若大量 499 伴随后端 LLM 429 报错，确认发生“孤儿长连接”现象。
   * **Step 2**：动态调小网关层与应用层的 Stream Timeout，在应用层灰度开启 Strict Cancellation 策略。
   * **Step 3**：临时针对高频慢查询工具注入 Stub 降级逻辑，切断级联阻塞，保护核心会话链路。

---

### 资深面试官追问
* **追问 1**：部分商业模型 API 在 HTTP POST 发送后，不支持通过 TCP FIN/RST 优雅停止计费，此时服务端即便断开连接，提供商仍扣全量 Token，架构上如何止损？
  * *答题要点*：若协议不支持中断计费，则架构应转为**异步任务解耦**（将任务转入后台任务系统将结果持久化至 Redis/向量库），提示用户“结果已存入历史记录”，避免直接丢弃造成的纯经济损失；同时对高频刷屏用户执行惩罚性降级。
* **追问 2**：在 Spring Boot 3 + Java 21 虚拟线程环境下，为什么使用 `WebClient` / 响应式依然比单纯在虚拟线程里阻塞读更适合 LLM 流式输出？
  * *答题要点*：虚拟线程解决了“并发阻塞等待”的线程资源开销，但**无法天然解决流式背压与取消事件的级联响应传递**。响应式流（Reactive Streams）原生具备完整的生命周期与取消信号链（Cancel Signal），更容易在长 I/O 管道中低成本实现全链路的快速熔断与资源回收。

---

### AI 应用层 GitHub 项目推荐

* **项目**：Aider-AI/aider
* **地址**：https://github.com/Aider-AI/aider
* **Star 数**：49,528
* **语言**：Python
* **简介**：aider is AI pair programming in your terminal
* **架构推荐理由**：Aider 是终端 AI 协同开发领域的标杆项目。其核心工程价值在于对大模型上下文管理（Context Caching、AST 代码解析与全量仓库地图构建）的极致优化，以及在复杂多轮代码编辑中，如何通过设计自愈机制（Git 自动回滚、语法检查 Lint 闭环反馈）来解决大模型幻觉与不确定性问题，是研究 Agent 鲁棒性架构设计的极佳范例。
