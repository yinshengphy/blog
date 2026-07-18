# Blog RAG k3s 清单

这个目录用于部署博客聊天 RAG 栈：

- `blog-service` 位于 `blog` 命名空间。
- `blog-indexer` CronJob 位于 `blog` 命名空间。
- `ai-compute-gateway`、`ai-compute-runtime` 和 `qdrant` 位于 `ai` 命名空间。

只有 `ai-compute-runtime` 申请 `nvidia.com/gpu: 1`。RAG API、网关、Qdrant 和索引器都是 CPU 工作负载。

## 当前模型

- 聊天模型：`huihui-qwen3:4b-instruct-2507-abliterated-q4_K_M`
- Embedding 模型：`bge-m3`
- 向量维度：`1024`

公网聊天默认使用 Q4_K_M 量化的 Qwen3 4B Instruct 纯文本模型，支持普通聊天和工具调用。保留 `qwen2.5:3b` 作为小型备用模型，`bge-m3` 用于生成博客向量。当前公开助手不支持图片识别和公共网页搜索。

## 构建镜像

在 Windows 上构建相邻模块镜像：

```powershell
cd C:\IdeaProjects\blog-service
mvn -B -DskipTests package jib:buildTar

cd C:\IdeaProjects\ai-compute-gateway
mvn -B -DskipTests package jib:buildTar
```

导入到 k3s containerd，并打上清单中使用的版本标签：

```bash
sudo k3s ctr images import /tmp/blog-service.tar
sudo k3s ctr images import /tmp/ai-compute-gateway.tar
sudo k3s ctr images tag --force localhost:5000/blog-service:latest localhost:5000/blog-service:20260707-2305
sudo k3s ctr images tag --force localhost:5000/ai-compute-gateway:latest localhost:5000/ai-compute-gateway:20260707-2305
```

不要让 Job 依赖 `latest`。当 `imagePullPolicy: IfNotPresent` 时，CronJob 可能继续使用旧的本地镜像。

## 应用清单

先创建真实 token Secret。生产环境不要原样应用 `01-secrets.example.yaml`。

```bash
kubectl apply -f 00-namespace.yaml
kubectl apply -f 02-qdrant.yaml
kubectl apply -f 03-ai-compute-runtime.yaml
kubectl apply -f 04-ai-compute-gateway.yaml
kubectl apply -f 05-blog-service.yaml
kubectl apply -f 06-blog-indexer.yaml
kubectl apply -f 07-ingress.yaml
kubectl patch deployment -n blog blog-web --type=strategic --patch-file 08-blog-web-runner-content-patch.yaml
```

在运行时 Pod 内拉取一次模型：

```bash
kubectl -n ai exec deploy/ai-compute-runtime -- ollama pull huihui-qwen3:4b-instruct-2507-abliterated-q4_K_M
kubectl -n ai exec deploy/ai-compute-runtime -- ollama pull qwen2.5:3b
kubectl -n ai exec deploy/ai-compute-runtime -- ollama pull bge-m3
```

## 验证

```bash
kubectl get pods -n blog
kubectl get pods -n ai
kubectl -n ai exec deploy/ai-compute-runtime -- ollama list
curl -s http://127.0.0.1/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"question":"RSA 是什么？"}'
curl -s -N http://127.0.0.1/api/chat/stream \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"question":"RSA 是什么？"}'
```

预期流式事件：

- `meta`
- 多个 `delta`
- `citations`
- `relatedPosts`
- `done`

Qdrant 中应存在 `blog_chunks`，向量维度为 `1024`，且 `points_count` 大于 0。
