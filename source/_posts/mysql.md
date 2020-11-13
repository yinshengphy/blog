---
title: 热备mysql部署方案总结
toc: true
thumbnail: /assets/posts/mysql/mysql-logo.png
date: 2020-10-20 10:15:54
tags:
- MySQL
- 分布式
categories:
- 教程
---
近一段时间的工作都是在部署mysql，主要涉及到mysql的主从复制，及配合keepalived实现mysql集群的高可用，这里是学习记录的总结。


<!-- more -->

# 前言

## 说明

为方便起见，这里我直接采用docker创建容器作演示用，软件版本如下

|  名称   | 版本  |
|  ----  | ----  |
| docker  | 19.03.5 |
| mysql  | 5.7 |

> 由于数据库作为一种IO密集应用，事实上并不适合用容器化实现，建议在生产环境单独为数据库单独分配服务器，这里仅提供环境用以说明原理

下面步骤将搭建互为热备的两台数据库，同时，借助keepalived来实现高可用
# 安装步骤

## 创建容器

直接在安装了docker的服务器上运行如下命令创建所需要的容器


```shell script
docker run -p 3307:3306 -e \          #占用宿主机端口3307
 MYSQL_ROOT_PASSWORD=root  \          #设置root密码为root
--name mysql_1 -d mysql:5.7 \         #指定容器名称，后台启动，指定镜像版本
--character-set-server=utf8mb4 \      #设置字符集
--lower_case_table_names=1 \          #忽略大小写
--log-bin=/var/lib/mysql/mysql-bin \  #设置binlog文件存储位置
--server-id=1                         #设置server-id，避免主从复制无限循环

docker run -p 3308:3306 -e \
 MYSQL_ROOT_PASSWORD=root  \
--name mysql_2 -d mysql:5.7 \
--character-set-server=utf8mb4 \
--lower_case_table_names=1 \
--log-bin=/var/lib/mysql/mysql-bin \
--server-id=2
```

完成后可查看效果

```shell script
[root@xxxx ~] docker ps |grep mysql
xxxxx    mysql:5.7    "docker-entrypoint.s…"   5 hours ago Up 5 hours   33060/tcp, 0.0.0.0:3308->3306/tcp mysql_2
xxxxx    mysql:5.7    "docker-entrypoint.s…"   5 hours ago Up 5 hours   33060/tcp, 0.0.0.0:3307->3306/tcp mysql_1
```

## 配置主从复制

```mysql
# mysql_2执行如下
CHANGE MASTER TO
master_host='xx.xx.xx.xx', #宿主机ip
master_port=3308,
master_user='root',
master_password='root';

start slave;

# mysql_1执行如下
CHANGE MASTER TO
master_host='xx.xx.xx.xx', #宿主机ip
master_port=3307,
master_user='root',
master_password='root';

start slave;
```
分别查看两台服务器主从复制状态

```shell script
SHOW SLAVE STATUS;
```
如果	Slave_SQL_Running及Slave_SQL_Running字段均为 Yes 则证明配置正确
