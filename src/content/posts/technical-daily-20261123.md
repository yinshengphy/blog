---
title: "技术深潜｜2026年11月23日"
date: "2026-11-23"
description: "围绕Spring 框架与生态的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["Spring 框架与生态", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-11-23】  
【今日方向】：Spring 框架与生态

### 场景 + 面试题

你负责订单服务，技术栈为 Spring Boot、Spring Transaction、MySQL、Kafka。订单创建接口峰值 5,000 TPS，要求：

- 订单与“订单创建事件”必须最终一致；
- 不允许引入 XA/分布式事务；
- Kafka 允许重复投递，但不能因重复消费重复扣库存；
- 接口 P99 小于 200 ms；
- 订单创建成功后，库存、积分、通知等下游通过事件异步处理。

初版代码在订单事务中直接调用 `KafkaTemplate.send()`，后来改为 `@TransactionalEventListener(phase = AFTER_COMMIT)`；上线后出现：

1. 数据库显示订单已创建，但 Kafka 偶发没有对应消息；
2. 下游偶发重复扣库存；
3. Kafka 短暂不可用时，订单接口延迟明显升高；
4. 部分开发者给监听器加 `@Async` 后，发现事务上下文和 MDC 链路信息丢失；
5. 使用 `@Transactional(propagation = REQUIRES_NEW)` 重试时，仍无法彻底解决消息丢失。

**请你从 Spring 事务代理、事件监听时机、消息投递语义和工程可靠性角度，设计一套生产可用方案，并说明如何监控和排障。**

### 一句话结论

不要把 Kafka 发送当作本地事务的一部分；应使用“订单与 Outbox 同库事务提交 + 独立可靠投递 + 消费端幂等”，并明确接受至少一次投递语义。

### 核心原理

`@Transactional` 通常通过代理在方法进入和退出时开启、提交或回滚事务；它只能保证同一事务资源中的数据库操作，不能自动覆盖 Kafka 发送。

`@TransactionalEventListener(AFTER_COMMIT)` 只是在本地事务成功提交后回调：

- 事务回滚：监听器不执行；
- 事务提交成功但 JVM 在回调前宕机：事件可能丢失；
- 回调内发送 Kafka 失败：数据库不会回滚；
- `@Async` 会切换线程，事务上下文、ThreadLocal 中的 MDC/SecurityContext 默认不会自动传播。

因此它适合“提交后的非关键通知”，不适合承担订单事件的可靠投递。

### 关键实现：Outbox

订单表和消息表放在同一个数据库，在一个本地事务中写入：

```java
@Transactional
public OrderId createOrder(CreateOrder cmd) {
    Order order = orderRepo.insert(cmd);

    outboxRepo.insert(new OutboxMessage(
        UUID.randomUUID().toString(),
        "ORDER_CREATED",
        order.id(),
        Jsons.toJson(order),
        "NEW"
    ));
    return order.id();
}
```

独立 Relay 轮询或订阅 Outbox：

```java
@Scheduled(fixedDelay = 100)
public void publish() {
    List<OutboxMessage> batch = outboxRepo.claimBatch(100);

    for (OutboxMessage msg : batch) {
        kafkaTemplate.send("order-events", msg.aggregateId(), msg.payload())
            .whenComplete((r, ex) ->
                outboxRepo.markResult(msg.id(), ex == null ? "SENT" : "RETRY"));
    }
}
```

生产实现还应具备：

- `claimBatch` 使用租约、版本号或 `SELECT ... FOR UPDATE SKIP LOCKED`；
- 发送状态、重试次数、下次重试时间、最后错误原因；
- Kafka producer 开启幂等能力，并合理设置 ACK；
- 超过阈值进入死信/人工处理；
- 消费端以 `eventId` 或业务唯一键做幂等记录；
- 订单状态变更与 Outbox 写入必须在同一数据库事务中。

### 工程取舍与故障边界

**优点：**

- 不需要 XA；
- 数据库提交与事件记录具备原子性；
- Kafka 短暂故障不会阻塞订单主流程；
- 可重试、可审计、可补偿。

**代价：**

- 引入 Outbox 表、Relay、状态管理；
- 存在投递延迟；
- Relay 崩溃或网络超时可能造成重复发送；
- “精确一次”不能仅靠 Spring 或 Kafka 端到端保证，必须依赖消费幂等。

不建议仅用 `REQUIRES_NEW` 修复：它只是开启新数据库事务，不能让“数据库提交”和“Kafka 成功”形成原子操作；如果 Kafka 已成功但 ACK 丢失，重试仍会重复发送。

需要特别说明的边界：

- Outbox 写入成功但数据库整体不可用：订单本身也应失败；
- Kafka 成功、服务在更新 Outbox 状态前宕机：必然可能重复发送；
- 消费端必须先判断幂等键，再执行扣库存；
- 库存扣减和消费记录也应设计为同库事务，或使用业务状态机/唯一约束保护。

### 监控与排障

重点指标：

- Outbox `NEW/RETRY` 数量、最老消息年龄；
- 投递成功率、重试次数、发送延迟、死信数量；
- Kafka producer error、request latency、发送超时；
- 消费端重复事件数、幂等冲突数、消费 lag；
- 订单创建成功到事件可消费的端到端延迟；
- 数据库连接池、锁等待、慢 SQL、Relay 扫描耗时。

排障顺序：

1. 用 `orderId/eventId/traceId` 串起订单、Outbox、Kafka、消费日志；
2. 查订单是否提交、Outbox 是否同事务写入；
3. 查 Relay 是否成功 claim，是否被租约卡住；
4. 查 Kafka ACK、超时和重平衡；
5. 查消费幂等表、库存流水和业务状态；
6. 区分“消息未发送”“发送成功但状态未更新”“重复消费”三类问题。

### 常见追问

- `@Transactional` 为什么在同类内部调用时可能失效？
- `@Async` 与事务、MDC、SecurityContext 如何传递？
- `BEFORE_COMMIT`、`AFTER_COMMIT`、`AFTER_ROLLBACK` 的适用场景是什么？
- 如何避免 Outbox 表无限增长？
- Relay 多实例如何避免重复 claim？
- Kafka 事务是否能替代 Outbox？它的边界是什么？
- 消费幂等键应选事件 ID、订单 ID，还是业务流水号？

### AI 应用层 GitHub 项目推荐

**LobeHub**  
GitHub：https://github.com/lobehub/lobehub  
简介：Super-Agents on Your Team，可将智能 Agent 接入团队已有聊天场景。  
语言：TypeScript；Stars：86,002；最近更新：2026-11-22。
