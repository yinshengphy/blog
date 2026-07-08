# Blog RAG k3s manifests

This directory deploys the blog chat RAG stack:

- `blog-rag-api` in namespace `blog`
- `blog-indexer` CronJob in namespace `blog`
- `ai-compute-gateway`, `ai-compute-runtime`, and `qdrant` in namespace `ai`

Only `ai-compute-runtime` requests `nvidia.com/gpu: 1`. The RAG API, gateway, Qdrant, and indexer are CPU workloads.

## Current Models

- Chat: `huihui-qwen3:4b-instruct-2507-abliterated-q4_K_M`
- Embedding: `bge-m3`
- Vector dimension: `1024`

The public chat default uses a Q4_K_M Qwen3 4B Instruct model for faster responses on the RTX 2060 6GB. Keep `qwen2.5:3b` installed as a small fallback model.

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

Import or pull models once inside the runtime. Copy the GGUF into the pod and create the model locally:

```bash
kubectl -n ai cp /tmp/Huihui-Qwen3-4B-Instruct-2507-abliterated.Q4_K_M.gguf deploy/ai-compute-runtime:/tmp/Huihui-Qwen3-4B-Instruct-2507-abliterated.Q4_K_M.gguf
kubectl -n ai exec deploy/ai-compute-runtime -- sh -c 'cat > /tmp/huihui-qwen3-q4.Modelfile <<EOF
FROM /tmp/Huihui-Qwen3-4B-Instruct-2507-abliterated.Q4_K_M.gguf
PARAMETER num_ctx 4096
EOF
ollama create huihui-qwen3:4b-instruct-2507-abliterated-q4_K_M -f /tmp/huihui-qwen3-q4.Modelfile'
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
