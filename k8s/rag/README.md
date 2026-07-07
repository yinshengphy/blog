# Blog RAG k3s manifests

This directory deploys the blog chat RAG stack:

- `blog-rag-api` in namespace `blog`
- `blog-indexer` CronJob in namespace `blog`
- `ai-compute-gateway`, `ai-compute-runtime`, and `qdrant` in namespace `ai`

Only `ai-compute-runtime` requests `nvidia.com/gpu: 1`. The RAG API, gateway, Qdrant, and indexer are CPU workloads.

## Current Models

- Chat: `qwen2.5:3b`
- Embedding: `bge-m3`
- Vector dimension: `1024`

`qwen3:4b` is installed on the runtime but is not the public chat default because the current model/runtime combination can stream thinking text as normal content. Re-enable it only after verifying that streaming output does not expose reasoning text.

## Build Images

Build sibling module images from Windows:

```powershell
cd C:\IdeaProjects\blog-rag-api
mvn -B -DskipTests package jib:buildTar

cd C:\IdeaProjects\ai-compute-gateway
mvn -B -DskipTests package jib:buildTar
```

Import them into k3s containerd and tag them with the manifest version:

```bash
sudo k3s ctr images import /tmp/blog-rag-api.tar
sudo k3s ctr images import /tmp/ai-compute-gateway.tar
sudo k3s ctr images tag --force localhost:5000/blog-rag-api:latest localhost:5000/blog-rag-api:20260707-2305
sudo k3s ctr images tag --force localhost:5000/ai-compute-gateway:latest localhost:5000/ai-compute-gateway:20260707-2305
```

Avoid relying on `latest` for Jobs. With `imagePullPolicy: IfNotPresent`, a CronJob can keep using an older local image.

## Apply

Create a real token secret first. Do not apply `01-secrets.example.yaml` unchanged in production.

```bash
kubectl apply -f 00-namespace.yaml
kubectl apply -f 02-qdrant.yaml
kubectl apply -f 03-ai-compute-runtime.yaml
kubectl apply -f 04-ai-compute-gateway.yaml
kubectl apply -f 05-blog-rag-api.yaml
kubectl apply -f 06-blog-indexer.yaml
kubectl apply -f 07-ingress.yaml
kubectl patch deployment -n blog blog-web --type=strategic --patch-file 08-blog-web-runner-content-patch.yaml
```

Pull models once inside the runtime:

```bash
kubectl -n ai exec deploy/ai-compute-runtime -- ollama pull qwen2.5:3b
kubectl -n ai exec deploy/ai-compute-runtime -- ollama pull bge-m3
```

## Verify

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

Expected stream events:

- `meta`
- many `delta`
- `citations`
- `relatedPosts`
- `done`

Qdrant should report `blog_chunks` with vector size `1024` and nonzero `points_count`.

