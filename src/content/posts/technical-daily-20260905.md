---
title: "技术深潜｜2026年09月05日"
date: "2026-09-05"
description: "围绕系统设计与高并发架构的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["系统设计与高并发架构", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-09-05】
【今日方向】：系统设计与高并发架构

**生产场景与故障还原**：
在千万级 DAU 交易系统中，针对超高并发单品秒杀（单 SKU 峰值 80,000 QPS），架构采用“本地双向滑动窗口限流 + Redis Cluster 执行 Lua 脚本扣减 + MQ 异步削峰落库 MySQL”的方案。在大促全链路压测期间，Redis 集群某分片 Master 节点由于网络微抖动触发 Sentinel/Cluster 自动故障转移（Failover）；同时，上游部分 Java 消费端因突发长时间 Major GC 发生 STW 假死。
**故障现象**：
1. 库存出现穿透性超卖（实际扣减数大于可售物理库存）；
2. 部分订单在 Redis 中扣减成功但因消费端超时重试导致 MQ 产生“幽灵履约流水”（用户未支付成功但锁券/流水记录已生成）；
3. 主从切换后，新 Master 读到已被丢弃的旧偏移量，库存产生“逆向回滚”现象。

---

### 一句话结论
高并发高价值状态变更严禁完全依赖异步非持久化缓存作为权威事实源；必须采用“带版本号与全局事务票据的分布式防重扣减”，结合“Redis 预扣 + 数据库租约乐观锁核验 + 分布式 Saga/对账状态机”闭环兜底。

---

### 核心原理
1. **Redis 异步复制与脑裂风险**：Redis 的主从复制为异步机制（`WAIT` 命令在极端高并发下会严重损害吞吐且非强一致）。当 Master 宕机前写入的数据尚未同步至 Replica，Failover 后新 Master 丢失增量数据，客户端基于旧数据重试必然发生超卖。
2. **GC 假死与双写时序倒置（幽灵写）**：消费端线程在 `Redis.decr` 成功与 `MQ.send` 之间发生长时间 STW，下游因超时触发重试机制；待 GC 恢复后，迟到的旧线程继续向外发送过期事件，导致乱序与幽灵流水。
3. **权威事实边界划分**：高并发架构应将系统解耦为“准实时高频拦截层（AP）”与“最终持久化防线（CP）”。Redis 仅作为“通行证发放者”，DB 依托“唯一业务幂等流水 + 带有符号校验/版本号的比对更新”做不可逆的终审判决。

---

### 关键实现（Java + Lua + DB）

**1. 严格原子扣减与防重凭证校验（Lua 脚本）**

```lua
-- KEYS[1]: 资源库存Key, KEYS[2]: 防重Token集合Key
-- ARGV[1]: 扣减数量, ARGV[2]: 全局唯一业务请求ID(RequestToken), ARGV[3]: 凭证过期时间(秒)
if redis.call('SISMEMBER', KEYS[2], ARGV[2]) == 1 then
    return -1 -- 重复请求，直接幂等拦截
end

local stock = tonumber(redis.call('GET', KEYS[1]) or '-1')
local deductNum = tonumber(ARGV[1])

if stock == -1 then
    return -2 -- 库存Key未加载或不存在
end

if stock >= deductNum then
    redis.call('DECRBY', KEYS[1], deductNum)
    redis.call('SADD', KEYS[2], ARGV[2])
    redis.call('EXPIRE', KEYS[2], ARGV[3])
    return 1 -- 扣减成功
else
    return 0 -- 库存不足
end
```

**2. 权威 DB 乐观安全回写（防超卖防御底线）**

```java
@Transactional(rollbackFor = Exception.class)
public boolean executeFinalDeduct(String skuId, int deductAmount, String requestId) {
    // 1. 插入流水防重表（利用唯一索引硬约束防止幽灵流水重放）
    try {
        deductRecordMapper.insert(new DeductRecord(requestId, skuId, deductAmount, Status.PENDING));
    } catch (DuplicateKeyException e) {
        log.warn("检测到重复流水重试，阻止重复扣减: {}", requestId);
        return true; // 触发幂等，视为已受理
    }

    // 2. 数据库行级行锁防超卖底线更新
    int updatedRows = skuStockMapper.deductStockSecurely(skuId, deductAmount);
    if (updatedRows == 0) {
        // 标记流水为失败，抛出异常触发回滚，并异步发送 Redis 补偿冲正消息
        deductRecordMapper.updateStatus(requestId, Status.FAILED);
        compensateRedisStock(skuId, deductAmount);
        throw new BusinessStockException("权威库存不足，执行熔断冲正");
    }
    
    deductRecordMapper.updateStatus(requestId, Status.SUCCESS);
    return true;
}
```

*注：SQL 原语必须约束：`UPDATE sku_stock SET available_stock = available_stock - #{deductAmount}, version = version + 1 WHERE sku_id = #{skuId} AND available_stock >= #{deductAmount}`*。

### 工程取舍
1. **强一致 vs 极端吞吐**：
   * *方案选择*：采用“Redis 前置预扣 + 本地 Token 幂等 + DB 异步落库最终一致”，而非两阶段提交（2PC/Seata AT）。
   * *代价*：放弃毫秒级跨系统绝对强一致性，允许在极低概率主从切换时发生“缓存少买/微量超发”，将防线后移至订单终审阶段。
2. **同步等待 vs 异步削峰**：
   * *方案选择*：下单扣减成功后立即给客户端返回成功凭证（Ticket），落库与支付流水全部异步化处理。
   * *代价*：增加了系统状态机复杂度，必须建设离线/准实时对账系统来修复漂移数据。

---

### 故障边界与防御降级
1. **Redis 脑裂与 Failover 窗口防护**：
   * 限制 `min-replicas-to-write 1` 和 `min-replicas-max-lag 3`，当复制延迟过高或无可用从节点时，拒绝写入并快速降级，防止脏数据堆积。
2. **GC 假死防护（租约/时钟跳跃）**：
   * MQ 消息体必须附带精确时间戳与租约有效期（Lease Expiration）。消费端落库前如果发现消息产生时间已超过阈值（如 5 秒），必须先校验订单真实状态再决定是否落库，拒绝盲目执行。
3. **超卖熔断兜底**：
   * 当 DB 乐观更新因“库存不足”更新失败时，触发硬熔断，直接阻断该 SKU 的 Redis 写入，并启动反向补回（Compensate）流程修正 Redis 的超买量。

---

### 监控指标与排障方向（非 K8s）
1. **JVM 层**：重点监控垃圾回收耗时（`jvm.gc.pause`）与安全点停顿（SafePoint Wait Time）。排查是否因 G1/ZGC 内存分配速率过高引发并发周期降级或 Full GC。
2. **Redis 状态**：
   * 监控 `master_sync_in_progress`、`sync_partial_err` 以及复制积压缓冲区偏移量差值（`master_repl_offset - slave_repl_offset`）；
   * 抓取慢查询日志 `SLOWLOG GET`，重点排查大 Key 集合（如 Set Token 膨胀）导致单线程阻塞。
3. **DB 引擎与连接层**：
   * 监控 `Innodb_row_lock_waits`（行锁等待次数）与 `Innodb_row_lock_time_avg`（平均锁等待时间）；
   * 关注 Druid/HikariCP 连接池的 `ActiveConnections` 与 `WaitThreadCount`，防止事务未提交耗尽池连接。
4. **数据一致性对账**：
   * 搭建准实时 Flink 消费 Binlog + Redis Monitor 流，计算 `DB物理库存 + 在途预占 - (初始库存 - 售出总量)` 差值，差值异常立即报警并冻结商品。

---

### 常见追问
* **追问 1**：如果使用 Redis 分段锁（将 1 个 SKU 库存拆为 10 个 Slot）来提升吞吐，用户购买多件时跨 Slot 扣减如何保证原子性？
  * *回答要点*：Hash 映射绑定分片，避免跨节点分布式事务；若跨分片则需基于全局固定顺序加锁执行 Lua，失败按逆序补偿回滚，或退化为单片串行处理。
* **追问 2**：大促结束后，Redis 中的防重 Set 集合占用大量内存，如何平滑淘汰且不影响线上业务？
  * *回答要点*：避免使用高危命令 `KEYS` 或无节制 `FLUSHDB`；写入时为 Set 挂载以小时/天为维度的分桶 Key，并注入随机 TTL 自然过期，或通过批处理游标 `SSCAN` + `SREM` 异步慢速摘除。
* **追问 3**：为什么不能用分布式锁（如 Redisson RLock）替代 Lua 脚本扣减？
  * *回答要点*：超高并发（8W QPS）下单点竞争锁会导致大量线程自旋重试，网络 RTT 开销陡增，导致吞吐断崖式下跌，且加锁无法天然消除主从异步同步的数据丢失问题。

---

### AI 应用层推荐项目
* **项目名称**：microsoft/autogen
* **GitHub 地址**：https://github.com/microsoft/autogen
* **核心定位**：A programming framework for agentic AI
* **技术栈与热度**：Python | ★ 60,800 Stars
