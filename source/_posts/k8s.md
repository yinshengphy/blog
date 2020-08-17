---
title: 容器化部署方案总结
toc: true
date: 2020-08-15 22:41:38
thumbnail: /assets/posts/k8s/Kubernetes-logo.png
tags:
- 容器化
- docker
- k8s
categories:
- 教程
---
最近一段时间都在研究**容器编排系统**（**Container Orchestration**），这里作一个学习记录的总结。

<!-- more -->

# 前言

## 说明
 容器化作为目前最新的虚拟化技术解决方案，相较于传统虚拟机有非常多的优点，我的总结就是更快，占用资源更少，及更好移植。在原理的实现上，虚拟机则是虚拟化硬件，因此容器更具有便携性、高效地利用服务器。 容器更多的用于表示 软件的一个标准化单元。由于容器的标准化，因此它可以无视基础设施（Infrastructure）的差异，部署到任何一个地方。配合**kubernetes**容器编排系统，可以为我们的应用容器实现服务发现，负载均衡，缺陷自修复，资源管理等等。
 docker官网：<https://www.docker.com/>
 kubernetes官网：<https://kubernetes.io/>
 
 全文均为围绕这两个工具及其相关组件展开，以本站作为一个参照例，详细介绍一个简单应用容器部署过程。
 
## 准备工作
需要一台或多台Linux公网服务器
>因为kubernetes作为分布式容器编排系统，如果在生产环境是会有多台服务器集群来提高容器虚拟化能力的，但是作为学习用途的话，用一台也可以达到效果

操作系统版本及配置信息（演示为例）：
CentOS Linux release 7.6.1810 (Core) 2核 8G

需要基本的linux操作基础

# 开始

各组件版本说明：

|  名称   | 版本  |
|  ----  | ----  |
| docker  | 19.03.5 |
| kubernetes  | v1.18.2 |
| kubernetes-dashboard  | v2.0.0-beta8 |
| helm  | v3.2.0 |
| drone  | 1.9.0 |

下面从各个组件分别开始部署流程

## docker

docker是什么，及与传统虚拟机区别，及它的优缺点，上文有所提及，更细节的部分，请各位自行查阅资料，这里仅对linux安装过程展开

```shell script
#添加源，选用阿里爸爸家的
yum-config-manager --add-repo http://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo

#生成包缓存
yum makecache fast
  
# 安装最新稳定版本的docker
yum install -y docker-ce
```

至此，安装步骤结束，接下来是配置及启动和设置自启动

同样选择阿里云镜像仓库，这里需要各位自己去申请一个自己的专属镜像仓库
地址：<https://cr.console.aliyun.com/cn-hangzhou/instances/mirrors>

大概长这样：https://xxxxx.mirror.aliyuncs.com

下面开始配置docker镜像仓库

```shell script
# 配置镜像加速器(注意要把下面的网址换成自己上面申请的)
mkdir -p /etc/docker

tee /etc/docker/daemon.json <<-'EOF'
{
  "registry-mirrors": ["https://xxxxx.mirror.aliyuncs.com"]
}
EOF

# 启动docker引擎并设置开机启动
systemctl start docker
systemctl enable docker
```
好了，如果没有报错，docker就已经安装及启动成功了

因为k8s的出现，我们已经不用docker作容器编排了（如docker-compose等），docker现在仅作为镜像的管理工具，及容器化的实现，但是，dockerfile的编写技巧仍然需要我们掌握，因为，docker
就是利用dockerfile来实现自定义镜像的，这里给出我觉得比较好的dockerfile总结<https://yeasy.gitbook.io/docker_practice/image/dockerfile/>

## docker 远程登录配置
默认情况下，docker通讯方式只能是本地形式调用，这对我们来说非常不方便，例如启动一个容器或者生成一个自定义镜像还需要ssh到运行docker daemon的主机上，下面就是相关的配置来启动docker的远程连接
>远程连接指的是安全的连接，即需要TLS证书认证的，如果是非安全的远程连接，任何客户端都可以对我们的docker daemon作任何的操作，这是非常危险的，尤其是在公网环境下。

官方文档：<https://docs.docker.com/engine/security/https/>

```shell script
#用OpenSSL工具创建一个根证书rsa私钥，会要求输入一个密码保护我们的私钥，这里我输入123456
openssl genrsa -aes256 -out ca-key.pem 4096

#申请根证书，这里除了要求填入上面设置的密码，还要输入例如国家，地区等等信息，如果嫌麻烦可以一路回车过去即可
openssl req -new -x509 -days 365 -key ca-key.pem -sha256 -out ca.pem

#生成一个证书私钥
openssl genrsa -out server-key.pem 4096

#用私钥去生成证书公钥
openssl req -subj "/CN=$HOST" -sha256 -new -key server-key.pem -out server.csr
```

这样，我们就获得了根证书和证书公钥，但是没有被根证书签名的证书公钥是没啥用的，我们下面的步骤就是用根证书去给我们的证书公钥签名
>各个证书签发公司都是同样的套路，用他们的根证书给我们的密钥对签名（有时候密钥对也是他们给创建好然后直接给我们签名完成的文件），我们的密钥对就是被认证过的了，这样，我们的网站上就会有https的标识及绿色的小锁，但是，证书却往往很贵，往往是几千到数万不等，事实上，你花的钱不是花在了证书签发的过程，而是花在了ca机构购买保险上了，以及ca机构为了让各个浏览器内置自己的根证书，从而花的一笔不小的费用，当然，你自己上面创建的ca签发的证书各个浏览器都不会出现绿色的小锁，原因就是你的根证书不在浏览器内置的受信任的根证书列表里面