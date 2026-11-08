<!--
  AgentStreamDrawerGuard —— agent 对话流抽屉的渲染边界（errorCaptured，2026-11 载体
  迁移配套）。AgentStreamDrawer 挂 u4 壳 #agent-drawer 具名 slot 后进入
  WorkflowVizOverlayGuard 的后代子树（slot 内容在组件树上是 u4 壳的后代），抽屉渲染
  抛错会冒泡触发 D10 壳回落（关 overlay）——连坐。本边界捕获后代错误：console 出声 +
  reportCapturedError 落盘取证 + 渲染 null（抽屉静默退出），overlay 主体不受影响——
  原「抽屉置于 Guard 外」语义在 slot 内的等价物（WorkflowVizDagNodeGuard 同款
  errorCaptured 边界手法）。
-->
<template>
  <slot />
</template>

<script setup lang="ts">
import { onErrorCaptured } from 'vue'
import { reportCapturedError } from '@/boot/error-reporter'

onErrorCaptured((err, _instance, info) => {
  // 出声不吞错：console 留诊断线索（错误对象 + 生命周期信息段），渲染侧静默退出
  console.error('[AgentStreamDrawerGuard] agent 抽屉渲染失败（静默退出，不连坐 overlay）', err, info)
  // return false 拦断后错误不再进全局 errorHandler，须在此补进 D2 单一上报通道（落盘取证）
  reportCapturedError(err, `workflow-viz-agent-drawer:${info}`)
  return false
})
</script>
