---
"@zhushanwen/subagent-core": patch
---

workflow 失败可感知性与派发卫生加固：① 脚本按模板族约定 `return {status:"failed"}` 收尾时，run 终态由 done/partially_succeeded 改档 failed（reason 携 failedStep）——此前脚本层失败结论只存在于 Script Result 段正文，run 终态恒显 completed，托盘画绿勾、通知写 "done (completed)"，页面与 runtime 感知不到失败；② workflow agent 派发空/非字符串/纯空白 prompt 时同步抛错 fail-fast（零池占用、零孤儿 record），不再派出空转轮次。
