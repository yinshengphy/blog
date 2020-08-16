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
 容器化作为目前最新的虚拟化技术解决方案，相较于传统虚拟机有非常多的优点，我的总结就是更快，占用资源更少，及更好移植。在原理的实现上，虚拟机则是虚拟化硬件，因此容器更具有便携性、高效地利用服务器。 容器更多的用于表示 软件的一个标准化单元。由于容器的标准化，因此它可以无视基础设施（Infrastructure）的差异，部署到任何一个地方。配合**kubernetes**容器
编排系统，可以为我们的应用容器实现服务发现，负载均衡，缺陷自修复，资源管理等等。
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
 