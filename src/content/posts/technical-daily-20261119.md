---
title: "技术深潜｜2026年11月19日"
date: "2026-11-19"
description: "围绕AI 工程与大模型应用开发的生产级技术推演、排障思路与 AI 应用项目推荐。"
tags: ["AI 工程与大模型应用开发", "Java", "系统设计", "AI 工程"]
categories: ["每日技术推送"]
---

【高级面试题｜2026-11-19】
【今日方向】：AI 工程与大模型应用开发

### 场景与问题

你负责一个面向企业客户的知识库问答系统：文档持续从网盘、工单和消息流进入系统，要求支持多租户、权限过滤、引用溯源和流式回答。

生产约束：

- 95% 请求端到端延迟低于 3 秒，首 token 低于 800ms；
- 单租户文档规模可达千万级，文档更新必须在 1 分钟内可检索；
- 召回结果必须满足用户权限，不能跨租户、跨部门泄露；
- 既要支持关键词精确匹配，也要支持语义检索；
- 上游大模型偶发超时、限流，且回答必须能展示引用来源。

近期故障现象：

1. 文档更新后，用户仍命中旧版本内容；
2. 高峰期首 token 延迟从 600ms 升至 5 秒；
3. 少量回答引用了用户无权访问的文档；
4. 重试后偶发出现重复引用、答案前后矛盾。

**问题：请你设计这套生产级 RAG 应用的架构、关键链路和故障处理方案，并说明如何定位上述问题？**

**一句话结论：生产级 RAG 的核心不是“把向量库接上大模型”，而是用版本化、可过滤的混合检索保证正确性，用异步解耦和受控降级保证延迟，再用权限、引用和可观测性形成闭环。**

### 核心原理与关键实现

**1. 摄取链路**

文档进入消息队列后，执行：

`解析 → 清洗 → 分块 → ACL 继承 → embedding → 索引 → 发布版本`

每个 chunk 必须携带：

`tenantId、documentId、version、chunkId、acl、contentHash、embeddingModel`

采用幂等键 `tenantId + documentId + version + chunkId`，先写入不可变版本，再通过原子指针发布“当前版本”。不要原地覆盖向量，避免更新期间读到半旧半新的数据。

**2. 查询链路**

先做租户与权限校验，再并行执行：

- BM25/倒排检索：擅长编号、错误码、专有名词；
- 向量检索：擅长语义相似；
- metadata filter：强制限制 `tenantId、acl、published=true`；
- RRF 或加权融合；
- reranker 重排；
- 上下文压缩与去重；
- 带引用 ID 的提示词生成答案。

权限过滤必须在检索层完成，不能只依赖 prompt 中的“不要泄露”。

```java
QueryResult answer(Query q, User user) {
    Filter f = Filter.of(
        "tenantId", user.tenantId(),
        "published", true,
        "acl", aclFor(user)
    );

    var lexical = bm25.search(q.text(), f, 30);
    var vector  = vector.search(embed(q.text()), f, 30);
    var docs = rerank(rff(lexical, vector), q.text())
        .stream()
        .filter(d -> aclService.allowed(user, d))
        .limit(8)
        .toList();

    return llm.generate(prompt(q, docs), timeoutMs(1800))
        .withCitations(docs);
}
```

### 工程取舍

- **一致性优先**：版本发布采用原子切换；允许短暂“不可见”，不接受读到未完成版本。
- **延迟优先**：embedding、BM25、向量检索并行；reranker 设置超时，超时可退化为融合排序。
- **成本优先**：查询改写和 rerank 只对复杂问题启用；embedding 与模型结果做缓存，但缓存键必须包含租户、权限版本和模型版本。
- **可靠性优先**：大模型采用超时、限流、熔断和有限重试；重试必须携带 requestId，并禁止把已生成部分重复拼接。

### 故障边界、监控与排障

**旧内容仍被命中**

检查 `documentId/version/contentHash` 是否变化、消费延迟、embedding 任务失败、索引构建状态及“当前版本”指针。重点区分“已摄取”“已向量化”“已发布”三个时间点；不能只看消息队列消费成功。

**首 token 变慢**

按阶段记录 trace：query rewrite、embedding、BM25、vector、rerank、prompt、LLM 排队和首 token。若检索耗时正常，重点看模型供应商限流、连接池、并发上限和重试放大；重试必须有预算，不能让一个请求同时等待多个模型调用。

**越权引用**

将 `tenantId、userId、aclVersion、filter` 写入审计日志；在线与离线分别做权限回归测试。最终答案中的 citation ID 必须只能映射到本次检索结果，不能接受模型自行生成 URL 或 documentId。发现越权时立即关闭受影响索引/租户的查询，并保留完整请求快照。

**重复引用、答案矛盾**

检查 requestId 是否在重试中复用、流式响应是否重复提交、上下文是否包含多个版本、chunk 是否重叠过度。对同一文档只保留最新已发布版本，并在 prompt 中明确“结论必须绑定 citation”。

核心指标包括：摄取延迟、版本发布延迟、检索命中率、空召回率、ACL 拒绝数、引用覆盖率、幻觉/人工纠错率、首 token/总延迟、模型错误率、重试率和 token 成本。

### 常见追问

- 如何评估 RAG：离线用 recall@k、MRR、nDCG；在线看 groundedness、citation precision、拒答正确率。
- 如何处理删除：删除事件必须生成新版本或 tombstone，并同步倒排、向量和缓存。
- 如何防提示词注入：文档内容视为不可信数据，结构化分隔；工具调用采用白名单和参数校验。
- 什么时候不用 RAG：稳定事实可进入结构化数据库或规则系统，RAG 不应替代事务查询。

### GitHub 项目推荐

**The-Vibe-Company/quivr**  
开源 AI 应用层引擎，支持持续内容流摄取、混合搜索、告警及插件扩展。  
GitHub：https://github.com/The-Vibe-Company/quivr  
语言：Go；Stars：39,653；最近更新：2026-11-18。
