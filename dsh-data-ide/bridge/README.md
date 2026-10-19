# bridge/ — Oracle Java 桥（M4 里程碑）

占位目录。M4 之前不产出任何内容。

## 目标形态（02 §4.2）

- 独立 `java -jar` 子进程，stdio JSON-lines 协议；
- 桥内 `URLClassLoader(parent=PlatformClassLoader, urls=[ojdbc11])` 加载 Oracle 驱动（镜像 DataGrip 实证的 base loader，RUNTIME-FINDINGS §3b）；
- 生命周期：懒启动（JVM 冷启动实测 ~7s，**禁止随用随起**）→ 空闲 10min 回收 → 崩溃重启；
- 冷启动超 30s → 连接测试返回 NO 态 + 原因。

## 协议（草案）

```
request:  { id, op: 'connect'|'query'|'cancel', ... }
response: { id, ok, rows?, columns?, error? }
```

## 合规

ojdbc11 走 OTN 许可，随包分发必须附许可声明（00 §8 / 08-RISKS R12）。jar 二进制不入 git（见 .gitignore）。

## 本机现状

`java` 当前不在 PATH —— M4 开工前需装 JDK/JRE 17+，并回记 docs/08 R4。
