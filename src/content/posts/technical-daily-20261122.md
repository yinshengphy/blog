---
title: "技术深潜｜2026年11月22日"
date: "2026-11-22"
description: "围绕Java 并发编程的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["Java 并发编程", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-11-22】
【今日方向】：Java 并发编程

一句话结论：高并发扣库存不能靠单机 `synchronized`，应采用“有界并发 + 原子预扣 + 幂等落库 + 可补偿状态机”，把并发安全、容量保护和最终一致性分别解决。

## 场景 + 面试题

某电商秒杀服务部署 20 个 Java 实例，活动库存 1,000 件，峰值请求 40,000 QPS。约束如下：

- 同一用户最多成功一次，绝不能超卖；
- 接口 P99 要低于 100ms；
- MySQL 主库最多承受约 3,000 次库存更新/秒；
- Redis Cluster 可用，但不能直接作为最终账本；
- 客户端和网关可能重试，网络可能在扣库存后断开。

线上曾出现：

1. 每台机器内部使用 `synchronized`，但最终仍有超卖；
2. 使用无界线程池处理异步落库，活动期间堆积数十万任务，老年代增长并触发 Full GC；
3. 请求超时后客户端重试，出现同一用户重复成功；
4. Redis 已扣库存，但数据库落库失败，库存长期对不上。

**问题：请你设计这套 Java 并发扣库存方案，并解释锁、线程池、幂等、数据一致性及故障恢复边界。**

## 原理 + 关键实现 + 工程取舍

### 1. 并发安全分层

- **单 JVM**：只负责保护本机共享对象，不能解决跨实例竞争；
- **Redis 原子操作**：用 Lua 一次完成“校验用户未购买、校验库存、扣减库存、记录订单标记”；
- **数据库最终确认**：使用唯一索引和状态机，数据库是最终账本；
- **幂等键**：以 `activityId + userId` 为业务唯一键，不能依赖请求线程或连接。

### 2. 有界线程池保护 JVM

```java
ExecutorService persistExecutor = new ThreadPoolExecutor(
        32, 64,
        60, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(2000),
        new ThreadFactoryBuilder().setNameFormat("stock-persist-%d").build(),
        new ThreadPoolExecutor.AbortPolicy()
);

public CompletableFuture<Result> submit(ClaimCommand cmd) {
    try {
        return CompletableFuture.supplyAsync(
                () -> claimService.reserveAndPersist(cmd), persistExecutor);
    } catch (RejectedExecutionException ex) {
        // 快速失败，返回限流/稍后重试；禁止继续堆积
        throw new TooBusyException();
    }
}
```

队列必须有界；拒绝策略应转化为明确的限流响应。`CallerRunsPolicy` 能反压，但可能把慢任务带回 Tomcat 工作线程，需结合接口超时谨慎使用。

### 3. Redis 原子预扣

Lua 脚本内完成：

```text
if userSet contains userId then return DUPLICATE end
if stock <= 0 then return SOLD_OUT end
decrement stock
add userId to userSet
create reservation(orderId, userId)
return SUCCESS
```

成功后写入可靠消息或 Outbox，异步落库；数据库插入订单时使用唯一索引，重复消息直接视为成功。落库失败不能简单重试无限次，应进入可重试或人工处理状态。

## 故障边界 + 监控排障 + 常见追问

### 工程取舍与故障边界

- Redis 预扣成功、消息未发送：使用 Redis Stream、可靠 MQ 或本地 Outbox；超时未确认的 reservation 进入补偿任务。
- 数据库落库成功、响应丢失：客户端重试通过幂等键查询原订单，不能再次扣库存。
- Redis 故障：不可降级为无锁直接写库；应快速失败或切换预案，否则会突破数据库容量。
- Redis 与数据库短暂不一致：以数据库订单状态为最终结果，补偿任务负责回滚未确认预扣。
- 进程崩溃：不能依赖 JVM 内存锁、`Future` 或本地队列保存业务事实。
- `volatile` 只保证可见性，不保证 `stock--` 的复合操作原子性；`AtomicInteger` 也只适合单 JVM，不能替代分布式一致性。

### 监控与排障

重点指标：

- 线程池 active、queue size、completed、reject count；
- Redis Lua 成功、重复、售罄、超时和错误数；
- reservation 创建到确认的延迟、超时回滚数；
- 数据库唯一键冲突、库存条件更新失败、事务耗时；
- 接口 P50/P99、429 比例、Full GC、堆使用率；
- “Redis 已预扣但 DB 无订单”的对账差异。

排障顺序：先看线程池拒绝和 GC，再看 Redis 原子脚本错误，随后核对幂等键、消息投递、数据库订单状态，最后执行对账和补偿；不要先把问题归因于“锁失效”。

### 常见追问

1. **为什么不用 `synchronized`？**  
   它只覆盖单 JVM，20 个实例之间没有互斥关系。

2. **为什么不用全局 Redis 分布式锁？**  
   锁粒度过粗、吞吐差；锁续期、客户端宕机和超时也会引入复杂故障。库存扣减更适合 Redis 原子脚本。

3. **为什么不直接用数据库 `stock = stock - 1 where stock > 0`？**  
   正确性可以保证，但在 40,000 QPS 和主库 3,000 更新/秒约束下会成为瓶颈。

4. **如何证明不重复成功？**  
   Redis 用户标记负责快速拦截，数据库 `activity_id + user_id` 唯一索引负责最终兜底，所有重试使用同一幂等键。

### AI 应用层 GitHub 项目

推荐：**open-webui/open-webui**  
描述：User-friendly AI Interface (Supports Ollama, OpenAI API, ...)  
语言：Svelte；Stars：159,222  
链接：https://github.com/open-webui/open-webui
