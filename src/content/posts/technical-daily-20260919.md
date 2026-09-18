---
title: "技术深潜｜2026年09月19日"
date: "2026-09-19"
description: "围绕软件工程能力与架构演进的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["软件工程能力与架构演进", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-09-19】
【今日方向】：软件工程能力与架构演进

### 场景 + 面试题

某电商平台原订单系统是单体应用：下单、扣库存、支付状态更新都在一个 MySQL 事务中完成。为支撑大促，团队准备将库存、支付通知、营销积分拆成独立服务，并通过消息事件解耦；但要求：

- 迁移期间不能停写，老客户端不能升级；
- 峰值订单流量 2000 QPS，订单写入 P99 小于 300ms；
- 订单不能因消息重复而重复扣库存；
- 允许最终一致，但支付成功后的订单状态延迟不能超过 30 秒；
- 不能依赖“消息恰好投递一次”；
- 需要支持失败重试、人工补偿和灰度回滚。

上线灰度后出现故障：少量订单已支付但仍显示“待支付”；部分库存被重复扣减；消息消费失败后重试导致下游压力持续升高；应用日志显示“订单事务已提交”，但消息平台中找不到对应事件。

**问题：请你设计这次架构演进方案，说明如何保证数据一致性、如何灰度迁移、如何处理重复与乱序、如何监控排障，并解释哪些故障必须自动恢复、哪些必须人工介入？**

### 一句话结论

不要追求跨服务“全局强一致”或消息“恰好一次”，应采用**本地事务 + Outbox 事件表 + 幂等消费 + 状态机 + 可重放补偿**，通过分阶段灰度完成从单体到事件驱动的演进。

### 核心原理

1. **避免数据库与消息平台双写**
   - 订单状态和 Outbox 事件必须在同一个本地数据库事务中提交。
   - 事务提交成功后，由可靠投递器异步发布事件。
   - 发布失败只影响事件延迟，不会产生“订单已提交但事件永久丢失”。

2. **幂等优先于去重**
   - 每个业务事件使用全局唯一 `eventId`。
   - 消费者以业务唯一键或消费记录表实现幂等。
   - 库存扣减应使用条件更新：`available >= quantity`，避免并发超卖。

3. **用状态机约束业务演进**
   - 订单状态只能沿合法路径迁移，例如：
     `待支付 -> 已支付 -> 已完成`
   - 重复、乱序事件不能直接覆盖状态，必须校验版本号或状态转移规则。

4. **最终一致性必须可观测、可修复**
   - 记录事件创建时间、发送时间、消费时间、重试次数和最终状态。
   - 对超时订单提供对账任务、重放机制和人工补偿入口。

### 关键实现

```java
@Transactional
public void createOrder(OrderCommand cmd) {
    Order order = orderRepo.insert(Order.pending(cmd));

    OutboxEvent event = OutboxEvent.of(
        UUID.randomUUID().toString(),
        "OrderCreated",
        order.getId(),
        order.getVersion(),
        Json.toJson(order)
    );
    outboxRepo.insert(event); // 与订单同一事务
}
```

```java
@Scheduled(fixedDelay = 100)
public void publishOutbox() {
    List<OutboxEvent> events = outboxRepo.lockBatch(100);
    for (OutboxEvent event : events) {
        try {
            broker.publish(event.getTopic(), event.getEventId(),
                           event.getPayload());
            outboxRepo.markSent(event.getEventId());
        } catch (Exception e) {
            outboxRepo.increaseRetry(event.getEventId(), e.getMessage());
        }
    }
}
```

```java
@Transactional
public void consumeInventory(OrderCreatedEvent event) {
    if (consumeRepo.exists(event.eventId())) return;

    int updated = inventoryRepo.decreaseIfEnough(
        event.sku(), event.quantity());

    if (updated == 0) {
        // 库存不足或数据异常，写入业务失败事件
        failureRepo.record(event.eventId(), "INSUFFICIENT_STOCK");
    }
    consumeRepo.insert(event.eventId()); // 唯一索引保证幂等
}
```

### 工程取舍

- **Outbox 优点**：可靠、容易审计和重放；代价是增加表、轮询或 CDC 资源消耗。
- **同步调用保留边界**：支付授权等强交互链路可暂时同步；积分、通知、搜索索引适合异步化。
- **重试必须有上限**：指数退避、最大次数、死信队列，避免故障时无限放大流量。
- **灰度策略**：先双写但只让新链路旁路校验，再按租户或订单分片切流；新旧结果持续比对，确认稳定后关闭旧路径。
- **回滚原则**：代码可回滚，数据和事件不能盲目回滚；通过兼容事件版本和补偿流程处理已产生的数据。

### 故障边界、监控与排障

**自动恢复范围：**

- Outbox 发布失败：自动重试；
- 消费者临时不可用：限速重试并进入死信；
- 重复消息：幂等表直接忽略；
- 短暂网络抖动：指数退避；
- 可确定的状态乱序：按版本号延迟或重新拉取。

**人工介入范围：**

- 支付渠道已成功，但本地订单超过 30 秒未更新；
- 库存账实不一致；
- 事件内容错误或版本不兼容；
- 重试达到上限且自动补偿失败；
- 消费者出现持续性业务拒绝，而非临时故障。

**重点监控：**

- Outbox：未发送数量、最老事件年龄、发送失败率；
- 消费：消费延迟、重试次数、死信数量、幂等命中率；
- 业务：支付成功到订单完成的延迟、库存差异、状态机非法迁移；
- 链路：按 `orderId/eventId/traceId` 串联订单、事件和消费日志；
- 数据：定时对账“支付渠道—订单库—库存库—事件表”。

**排障顺序：**

1. 先根据 `orderId` 查订单状态、版本和最后更新时间；
2. 查 Outbox 是否生成、是否发送、发送响应是什么；
3. 查消息平台的分区、消费位点、重试和死信；
4. 查消费者幂等记录、数据库锁等待和条件更新结果；
5. 对比支付渠道与本地订单，判断是事件丢失、消费延迟还是状态迁移错误；
6. 通过安全重放或人工补偿修复，并保留审计记录。

### 常见追问

1. **Outbox 表本身所在数据库宕机怎么办？**  
   依赖数据库高可用、备库切换和故障演练；不能把可靠性假设建立在单实例上。

2. **为什么不直接使用分布式事务？**  
   跨支付、消息和库存系统的长事务会降低吞吐并扩大故障域；优先采用短本地事务和业务补偿。

3. **消费者先扣库存、后写幂等记录会重复吗？**  
   会。应使用同库事务、业务唯一约束，或让库存扣减与消费记录处于同一可靠边界。

4. **事件版本升级如何兼容？**  
   采用向后兼容字段、事件版本号、消费者适配层；禁止直接修改既有事件语义。

### AI 应用层 GitHub 项目推荐

**Continue**：开源 coding agent，TypeScript，35,950 stars；最近更新于 2026-09-18。  
https://github.com/continuedev/continue
