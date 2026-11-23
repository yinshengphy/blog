---
title: "技术深潜｜2026年11月24日"
date: "2026-11-24"
description: "围绕MySQL 与关系型数据库的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["MySQL 与关系型数据库", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-11-24】
【今日方向】：MySQL 与关系型数据库

### 场景 + 问题

某电商大促，秒杀商品库存 100 件，订单服务使用 MySQL 8.0 InnoDB，主库 1 个、只读副本 2 个，应用采用读写分离。峰值约 1 万 QPS，要求：

- 同一用户、同一商品只能成功下单一次；
- 绝不能超卖；
- 下单接口 P99 小于 200ms；
- 支付在事务外完成，支付失败后需要释放库存；
- 允许少量请求因竞争失败，但不能长时间阻塞；
- 主库故障时需要切换，不能依赖人工修数据。

现网实现是“先查询库存，再插入订单，再扣减库存”。故障现象如下：

1. 大促期间出现超卖，库存表出现负数；
2. 部分用户重复下单；
3. `Lock wait timeout exceeded` 和死锁明显增加；
4. 只读副本延迟最高 40 秒，用户偶尔看到“已下单”但查询结果为空；
5. 主库 CPU 不高，但接口 RT 飙升。

**问题：请你设计正确的事务与数据模型，并解释如何定位上述故障、如何处理死锁、复制延迟和主库切换？哪些方案看似有效但实际上不可靠？**

### 一句话结论

库存扣减必须由主库内 InnoDB 事务中的原子条件更新决定，订单用唯一键保证幂等，写后读走主库或带位点的一致性读取，不能依赖“先查再改”或副本读取来保证业务正确性。

### 核心原理

- “查询库存再扣减”存在 TOCTOU 竞态：多个事务都读到库存 1，随后都执行扣减。
- `UPDATE ... SET stock = stock - 1 WHERE stock > 0` 是数据库层面的原子竞争，只有一个事务能成功更新最后一个库存。
- 同一用户、商品的幂等性必须由唯一索引兜底，不能只依赖应用层判断。
- InnoDB 行锁只在事务提交或回滚后释放；事务中调用支付、RPC 或执行慢查询，会放大锁等待。
- 读副本是异步复制，不能承担“刚写入数据必须马上可见”的查询。
- RR 隔离级别并不能消除业务竞态；正确的更新条件、唯一约束和事务边界才是关键。

### 原理 + 实现 + 工程取舍

推荐表约束：

```sql
CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  status TINYINT NOT NULL,
  UNIQUE KEY uk_user_sku (user_id, sku_id)
) ENGINE = InnoDB;

CREATE TABLE sku_stock (
  sku_id BIGINT PRIMARY KEY,
  available INT NOT NULL,
  reserved INT NOT NULL DEFAULT 0,
  CHECK (available >= 0)
) ENGINE = InnoDB;
```

下单核心事务应尽量短：

```sql
START TRANSACTION;

UPDATE sku_stock
SET available = available - 1,
    reserved = reserved + 1
WHERE sku_id = ? AND available > 0;

-- affected_rows = 0：库存不足，立即回滚
INSERT INTO orders(id, user_id, sku_id, status)
VALUES (?, ?, ?, 0);

COMMIT;
```

更稳妥的做法是固定加锁顺序，并处理唯一键冲突：

1. 以请求幂等号或 `user_id + sku_id` 生成业务唯一键；
2. 先执行条件扣库存，再插入订单，所有写操作位于一个本地事务；
3. 唯一键冲突时查询已有订单并返回成功，不能再次扣库存；
4. 死锁只对整个事务做有限次数、带随机退避的重试，必须使用同一个幂等号；
5. 支付不放在数据库事务内，支付成功后通过状态机确认；超时未支付则异步释放预占库存。

取舍：

- **单行原子扣减**：实现简单、正确性强，但热点 SKU 会形成行锁竞争；
- **库存分桶**：把一个 SKU 拆成多个库存行，降低单行热点，但查询、扣减和回补复杂；
- **预扣库存**：降低支付链路耦合，但必须有超时释放、补偿和状态机；
- **串行队列**：削峰明显，但会增加架构复杂度和端到端延迟，不能替代最终数据库约束；
- **READ COMMITTED** 可降低部分间隙锁影响，但不能替代条件更新和唯一键。

### 故障边界与排障

先确认超卖是否来自业务流程，而不是只看库存表：检查是否存在“库存扣减成功但订单插入失败后未回滚”、补偿重复执行、手工修数，以及是否有绕过主库的写入路径。

重点指标和命令：

```sql
SHOW ENGINE INNODB STATUS\G;

SELECT * FROM performance_schema.data_lock_waits;
SELECT * FROM performance_schema.data_locks;
SELECT * FROM performance_schema.events_statements_summary_by_digest
ORDER BY SUM_TIMER_WAIT DESC LIMIT 20;
```

同时监控：

- `Innodb_row_lock_time`、锁等待数、死锁次数；
- 慢查询、扫描行数、事务持续时间；
- 主从 `Seconds_Behind_Source`、IO/SQL 线程状态、Relay Log 堆积；
- 按 SQL 统计 `affected_rows=0`、唯一键冲突和重试次数；
- 主库切换期间的连接错误、GTID 位点和写入可用性。

排查顺序：

1. 用 `performance_schema` 找阻塞者、被阻塞者和事务持有时间；
2. 检查是否有不同代码路径按不同顺序更新订单、库存、优惠券；
3. 查看执行计划，确认 `sku_id`、唯一键被正确使用；
4. 区分锁等待、CPU、磁盘 IO 和连接池耗尽；
5. 副本延迟时，订单确认、扣库存结果和写后查询临时强制走主库；
6. 切换必须基于 GTID/一致位点，禁止直接把落后的副本提升为主库；切换后校验幂等写入和未提交事务。

常见追问：

- **为什么加 Redis 分布式锁还超卖？** 锁失效、误删、超时和绕过锁的路径都会破坏正确性，数据库约束仍是最终兜底。
- **为什么把库存查询改成 `SELECT FOR UPDATE` 不一定最好？** 它能串行化，但会先持有锁、增加往返和等待；条件 `UPDATE` 通常更短。
- **副本延迟如何彻底解决？** 异步复制无法保证零延迟；需主库读、半同步/增强同步、读后等待位点，或接受最终一致性。
- **死锁是否说明数据库有问题？** 不一定。死锁是并发事务形成环路，应用应固定访问顺序并可安全重试。
- **如何防止补偿重复释放库存？** 使用订单状态机、版本号或唯一补偿流水号，让释放操作幂等。

### AI 应用层 GitHub 项目推荐

**OpenHands/OpenHands**  
描述：🙌 OpenHands: AI-Driven Development  
语言：TypeScript  
Stars：94,165  
更新时间：2026-11-23  
链接：https://github.com/OpenHands/OpenHands
